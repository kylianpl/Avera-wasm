import { RingBuffer } from "./libs/ringbuf.js";
import * as LibAVJSWebCodecs from "../packages/wc-bridge/src/bridge.js";
import { parseSrtPacket, parseAssPacket, parseTx3gSample, packetToCue } from "../packages/sub-decode/src/index.js";
import { hdrMode, toWebCodecsColorSpace } from "../packages/color-meta/src/index.js";
import { LibAV } from "../packages/demux-compat/src/compat.js";
import {
  ff_copyout_codecpar as ff_copyout_codecpar_raw,
  avcodec_get_name as avcodec_get_name_raw,
  ff_error as ff_error_raw,
  ff_init_decoder as ff_init_decoder_raw,
  ff_decode_multi as ff_decode_multi_raw,
  ff_free_decoder as ff_free_decoder_raw,
  avcodec_flush_buffers as avcodec_flush_buffers_raw,
} from "../packages/demux-compat/src/compat.js";
// Note Phase 3/Slice 1 : le rendu vit dans render-worker.js (VideoFrames
// transférables). Ici : décisions de présentation + envoi (jamais de pixels).
// Note Phase 3/Slice 2 : le démux vit dans demux-worker.js. `this.libav` est
// une FAÇADE (mêmes noms/mêmes signatures) : I/O + lecture via RPC, pur en
// direct. Les call sites ne changent pas.

/** Durée lisible pour les logs ([media]). */
function formatSec(seconds) {
  if (!(seconds > 0)) return "?";
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return (h ? `${h}:` : "") + `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

class MediaWorker {
  constructor() {
    this.canvas = null; // non utilisé (le canvas vit dans render-worker)
    this.renderPort = null; // MessagePort vers render-worker (frames + clear)
    this._lastSentPts = null; // pts de la tête déjà postée (pas de re-post)
    this._renderDrawn = 0; // acks render (stats beta)
    this.renderer = null; // non utilisé (rendu dans render-worker)
    this.isPlaying = false;
    this.isSeeking = false;
    this.fileEnded = false;

    this.sharedArrayBuffer = null;
    this.ringbuffer = null;

    this.libav = null;
    this.formatContext = null;
    this.streams = null;
    this.videoStreamIndex = -1;
    this.audioStreamIndex = -1;
    this.subtitleStreamIndex = -1;
    this.subtitleCues = [];
    this.packet = null;

    this.availableStreams = [];
    this.channelCount = 0;
    this.audioSampleRate = 0;
    this.videoTimeStart = null;
    this.pausedVideoTime = null;

    this.audioUseWebCodecs = false;
    this.videoUseWebCodecs = false;
    this.audioConfig = null;
    this.videoConfig = null;
    this.WCAudioDecoder = null;
    this.WCVideoDecoder = null;

    this.AudioDecoderCodecContext = null;
    this.AudioDecoderPacket = null;
    this.AudioDecoderFrame = null;
    this.VideoDecoderCodecContext = null;
    this.VideoDecoderPacket = null;
    this.VideoDecoderFrame = null;

    // 6 s de capacité / cible 4 s : les frames 4K saturent le worker par
    // rafales (GC, décodage) ; un creux de ~2 s ne doit pas trouer l'audio.
    this.DATA_BUFFER_DURATION = 6.0;
    this.DATA_BUFFER_DECODE_TARGET_DURATION = 4.0;
    this.DECODER_QUEUE_SIZE_MAX = 24; // file decodeur profonde (~1s) : les
    // décodeurs qui émettent par rafales se coincent nourris au compte-gouttes
    // (observé : 3/s plafonné à 5, 145/s en flood). La présentation (dû/périmé)
    // trie les sorties ; pas de gate fraîcheur artificielle ici.
    this.FRAME_BUFFER_TARGET_SIZE = 5;
    this.PACKET_QUEUE_MIN_SIZE = 60;
    this.PACKET_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
    this.PACKET_QUEUE_BYTES_VIDEO = 0;
    this.PACKET_QUEUE_BYTES_AUDIO = 0;

    this.videoFrameBuffer = [];
    this.videoFillInProgress = false;
    this.audioFillInProgress = false;
    this.queueFillInProgress = false;

    this.videoPacketQueue = [];
    this.audioPacketQueue = [];
    this.PACKET_QUEUE_BYTES_AUDIO = 0;

    this.feedAudioDecoderTimeout = null;
    this.renderRafId = null;
    this.pipelinePumpScheduled = false;
    this.generation = 0;
    this.sourceName = null; // legacy (I/O côté demux-worker) : gardé, inutilisé
    this.seekSerial = 0;
    this.audioPrerollTargetSeconds = null;
    this.lastAVDifference = 0;
    this.avDriftReportInterval = null;

    this.lagMonitor = {
      lastFrameTime: 0,
      frameTimes: [],
      totalLagEvents: 0,
      reportInterval: 3000,
      lastReportTime: 0,
      lagThresholdMs: 50,
    };


    // Set up message handler
    self.onmessage = this.handleMessage.bind(this);

    // Initialize LibAV
    this.initLibAV();
  }

  // Client RPC vers demux-worker (Slice 2) : corrélation par id + timeout.
  demuxCall(op, payload = {}, transfer = []) {
    const port = this.demuxPort;
    if (!port) return Promise.reject(new Error("demux non connecté"));
    if (!this._demuxSeq) {
      this._demuxSeq = 0;
      this._demuxPending = new Map();
      port.onmessage = (e) => {
        const d = e.data;
        if (!d || d.id === undefined) return;
        const w = this._demuxPending.get(d.id);
        if (!w) return;
        this._demuxPending.delete(d.id);
        clearTimeout(w.timer);
        if (d.ok) w.resolve(d);
        else w.reject(new Error(d.error || op));
      };
    }
    const id = ++this._demuxSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._demuxPending.delete(id);
        reject(new Error(`demux ${op} timeout`));
      }, 30000);
      this._demuxPending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ id, op, gen: this.demuxGen ?? 0, ...payload }, transfer);
      } catch (err) {
        this._demuxPending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // Façade this.libav : mêmes noms que libav.js. I/O + lecture via RPC vers
  // demux-worker ; pur (codecpar/noms/consts/erreurs) en direct.
  buildDemuxFacade() {
    const self = this;
    const openCache = { durationTicks: -1, chapters: [] };
    self._openCache = openCache;
    return {
      onblockread: null, // sans objet (I/O côté demux-worker)
      AV_TIME_BASE: 1000000,
      AVSEEK_FLAG_BACKWARD: 1,
      AVERROR_EOF: -541478725,
      EAGAIN: 11,
      AVMEDIA_TYPE_UNKNOWN: -1,
      AVMEDIA_TYPE_VIDEO: 0,
      AVMEDIA_TYPE_AUDIO: 1,
      AVMEDIA_TYPE_DATA: 2,
      AVMEDIA_TYPE_SUBTITLE: 3,
      AVMEDIA_TYPE_ATTACHMENT: 4,
      async mkblockreaderdev() { return 0; },
      async unlink() { return 0; },
      async ff_block_reader_dev_send() { return 0; },
      async ff_init_demuxer_file() {
        const r = await self.demuxCall("open", { url: self._openUrl, wasm: self._wantWasm ?? true });
        openCache.durationTicks = Number(r.durationNs) >= 0 ? Math.round(Number(r.durationNs) / 1000) : -1;
        openCache.chapters = r.chapters ?? [];
        openCache.sizeBytes = r.sizeBytes ?? null;
        openCache.kind = r.kind ?? null;
        self.formatContext = { url: self._openUrl };
        return [self.formatContext, r.streams];
      },
      async ff_read_frame_multi() {
        // Remplacé par readDemuxPackets (quotas + génération) — appel direct interdit.
        throw new Error("ff_read_frame_multi: passer par readDemuxPackets");
      },
      async av_seek_frame(fc, stream, ts) {
        self.demuxGen = (self.demuxGen ?? 0) + 1;
        const r = await self.demuxCall("seek", { streamIdx: stream, ns: String(ts), gen: self.demuxGen });
        return r.res ?? 0;
      },
      async avformat_seek_file_max(fc, stream, ts) {
        self.demuxGen = (self.demuxGen ?? 0) + 1;
        const r = await self.demuxCall("seek", { streamIdx: stream, ns: String(ts), gen: self.demuxGen });
        return r.res ?? 0;
      },
      /** Seek sans attendre la réponse (MP4 : synchrone côté démux ; l'ordre
       * FIFO du port garantit que les read suivants voient le curseur). */
      avformat_seek_file_nowait(fc, stream, ts) {
        self.demuxGen = (self.demuxGen ?? 0) + 1;
        try {
          self.demuxPort?.postMessage({
            id: -1, op: "seek", gen: self.demuxGen,
            streamIdx: stream, ns: String(ts),
          });
        } catch {}
        return 0;
      },
      async ff_copyout_codecpar(t) { return ff_copyout_codecpar_raw(t); },
      avcodec_get_name(id) { return avcodec_get_name_raw(id); },
      async ff_error(r) { return ff_error_raw(r); },
      async AVFormatContext_duration() { return openCache.durationTicks; },
      async AVFormatContext_metadata() { return 0; },
      async ff_copyout_dict() { return {}; },
      async ff_get_demuxer_chapters() { return openCache.chapters; },
      async av_packet_alloc() { return {}; },
      async ff_init_decoder(...a) { return ff_init_decoder_raw(...a); },
      async ff_decode_multi(...a) { return ff_decode_multi_raw(...a); },
      async ff_free_decoder(...a) { return ff_free_decoder_raw(...a); },
      async avcodec_flush_buffers(...a) { return avcodec_flush_buffers_raw(...a); },
    };
  }

  async initLibAV() {
    if (!this.libav) {
      // Plus de libav ici : façade RPC (le démux tourne dans demux-worker).
      this.libav = this.buildDemuxFacade();
      console.log(`[worker] demux backend: demux-worker (RPC)`);
    }
  }

  // Handle messages from main thread
  async handleMessage(e) {
    switch (e.data.type) {
      case "init":
        await this.init(e.data);
        break;
      case "reinit":
        await this.reInit(e.data);
        break;
      case "start":
        await this.startOutput();
        this.updateMediaTime(e.data.pausedVideoTime, e.data.videoTimeStart);
        break;
      case "stop":
        this.stopOutput();
        this.updateMediaTime(e.data.pausedVideoTime, e.data.videoTimeStart);
        break;
      case "updateMediaTime":
        this.updateMediaTime(e.data.pausedVideoTime, e.data.videoTimeStart);
        break;
      case "seek":
        await this.seek(e.data.seconds, e.data.videoTimeStart);
        break;
      case "changeStream":
        await this.changeStream(e.data.streamType, e.data.index);
        break;
      case "subtitle":
        await this.selectSubtitle(e.data.index);
        break;
      case "stats": {
        // Debug beta : compteurs instantanés (inaudible en prod).
        let demux = null;
        try { demux = await this.demuxCall("stats"); } catch {}
        self.postMessage({          type: "statsReport",
          vFed: this._vFed ?? 0,
          vOut: this._vOut ?? 0,
          vQ: this.videoPacketQueue.length,
          vQBytes: this.PACKET_QUEUE_BYTES_VIDEO,
          vBuf: this.videoFrameBuffer.length,
          vBuf0Ts: (() => { try { return this.videoFrameBuffer.length ? this.videoFrameBuffer[0].timestamp : null; } catch { return null; } })(),
          vClockMs: (() => { try { return Math.round(this.currentVideoTime()); } catch { return null; } })(),
          decQ: (() => { try { return this.WCVideoDecoder?.decodeQueueSize ?? null; } catch { return null; } })(),
          decState: this.WCVideoDecoder?.state ?? null,
          aFed: this._aFed ?? 0,
          aOut: this._aOut ?? 0,
          aQ: this.audioPacketQueue.length,
          fileEnded: this.fileEnded,
          playing: this.isPlaying,
          renderDrawn: this._renderDrawn ?? 0,
          posted: this._posted ?? 0,
          inFlightFrames: this._framesInFlight ?? 0,
          staleDropped: this._staleDropped ?? 0,
          demuxPos: this._demuxPos ?? null,
          lateDropped: this._lateDropped ?? 0,
          frameMax: this.frameBufferMax(),
          aRefillMs: Math.round(this._aRefillMs ?? 0),
          readRpcMs: Math.round(this._readRpcMs ?? 0),
          readRpcs: this._readRpcs ?? 0,
          aFillAgo: this._aFillAt ? Math.round(performance.now() - this._aFillAt) : null,
          ringMin: this._ringMin == null ? null : this._ringMin,
          staleClock: this._staleClockUpdates ?? 0,
          ringSecs: (() => { try {
            return this.ringbuffer ? (this.ringbuffer.capacity() - this.ringbuffer.available_write()) / (this.channelCount * this.audioSampleRate) : null;
          } catch { return null; } })(),
          demux,
        });
        break;
      }
      default:
        console.warn("Unknown message type:", e.data.type);
    }
  }

  // Initialize worker with canvas and video
  async init(data) {
    if (data && data.wasm !== undefined) this._wantWasm = !!data.wasm;
    if (data && data.forceSW !== undefined) this._forceSW = !!data.forceSW;
    if (data && data.demuxPort) this.demuxPort = data.demuxPort;
    if (data && data.renderPort) {
      this.renderPort = data.renderPort;
      this.renderPort.onmessage = (e) => {
        if (e.data && e.data.type === "drawn") {
          this._renderDrawn = (this._renderDrawn ?? 0) + 1;
          this._framesInFlight = Math.max(0, (this._framesInFlight ?? 0) - 1);
        }
      };
    }
    // (canvas ignoré : appartient à render-worker ; les renderers
    // redimensionnent seuls par frame.)
    await this.playerInit(data.video);
  }

  // (createRenderer supprimé Slice 1 : voir render-worker.js pickRenderer.)

  async reInit(data) {
    this.generation++;
    this.seekSerial++;
    if (data && data.wasm !== undefined && !!data.wasm !== !!this._wantWasm) {
      this._wantWasm = !!data.wasm;
      this.libav = null; // force la réinit (change de backend parse)
    }
    if (data && data.forceSW !== undefined) this._forceSW = !!data.forceSW;
    this.cancelRenderLoop();
    this.isPlaying = false;
    self.postMessage({ type: "videoStatus", isPlaying: false });
    self.postMessage({ type: "buffering", buffering: true });
    await this.cleanupSource();
    await this.cleanupAudio();
    await this.cleanupVideo();
    this.isSeeking = false;
    this.audioStreamIndex = -1;
    this.videoStreamIndex = -1;

    this.availableStreams = [];
    this.channelCount = 0;
    this.audioSampleRate = 0;
    this.videoTimeStart = null;
    this.pausedVideoTime = null;

    this.videoFillInProgress = false;
    this.audioFillInProgress = false;
    this.queueFillInProgress = false;

    this.formatContext = null;
    this.fileEnded = false;
    this.clearPacketQueues();
    this.audioPrerollTargetSeconds = null;
    this.pausedVideoTime = 0;
    this.videoTimeStart = performance.now();
    this.postRenderClear(); // render-worker oublie son image (le clear main passe par self, ignoré)

    await this.playerInit(data.video);
    if (this.formatContext) {
      await this.showInitialFrame();
    }
  }

  async playerInit(videoURL) {
    const generation = ++this.generation;
    try {
      await this.initLibAV();
      await this.openSeekableSource(videoURL, generation);
      if (generation !== this.generation) return;
      [this.formatContext, this.streams] =
        await this.libav.ff_init_demuxer_file(this.sourceName);

      this.availableStreams = {
        video: [],
        audio: [],
        subtitle: [],
        other: [],
      };
      for (const streamInfo of this.streams) {
        if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_VIDEO) {
          var codecpar = await this.libav.ff_copyout_codecpar(
            streamInfo.codecpar,
          );
          if (this.videoStreamIndex == -1) {
            this.videoStreamIndex = streamInfo.index;
            // (Dimensionnement canvas : render-worker, par frame.)
          }
          this.availableStreams.video.push({
            index: streamInfo.index,
            type: "video",
            codec: await this.libav.avcodec_get_name(streamInfo.codec_id),
            metadata: streamInfo.metadata,
            selected: this.videoStreamIndex == streamInfo.index,
            width: codecpar.width,
            height: codecpar.height,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_AUDIO) {
          var codecpar = await this.libav.ff_copyout_codecpar(
            streamInfo.codecpar,
          );
          if (this.audioStreamIndex == -1) {
            this.audioStreamIndex = streamInfo.index;
          }
          this.availableStreams.audio.push({
            index: streamInfo.index,
            type: "audio",
            codec: await this.libav.avcodec_get_name(streamInfo.codec_id),
            metadata: streamInfo.metadata,
            selected: this.audioStreamIndex == streamInfo.index,
            channelCount: codecpar.channels,
            sampleRate: codecpar.sample_rate,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_SUBTITLE) {
          this.availableStreams.subtitle.push({
            index: streamInfo.index,
            type: "subtitle",
            codec: await this.libav.avcodec_get_name(streamInfo.codec_id),
            metadata: streamInfo.metadata,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_ATTACHMENT) {
          this.availableStreams.other.push({
            index: streamInfo.index,
            type: "attachment",
            metadata: streamInfo.metadata,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_DATA) {
          this.availableStreams.other.push({
            index: streamInfo.index,
            type: "data",
            metadata: streamInfo.metadata,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_UNKNOWN) {
          this.availableStreams.other.push({
            index: streamInfo.index,
            type: "unknown",
            metadata: streamInfo.metadata,
          });
        }
      }

      // Notify main thread that initialization is complete
      const duration =
        (await this.libav.AVFormatContext_duration(this.formatContext)) /
        this.libav.AV_TIME_BASE;

      const metadata = await this.libav.ff_copyout_dict(
        await this.libav.AVFormatContext_metadata(this.formatContext),
      );
      const chapters = await this.libav.ff_get_demuxer_chapters(
        this.formatContext,
      );
      const mediaInfo = {
        url: this._openUrl ?? null,
        sizeBytes: this._openCache?.sizeBytes ?? null,
        kind: this._openCache?.kind ?? null,
        duration,
      };
      self.postMessage({
        type: "initFinished",
        availableStreams: this.availableStreams,
        duration: duration,
        mediaInfo,
      });
      // Diagnostic : source + débit (lisible sans inspecter les workers).
      try {
        const sizeTxt = mediaInfo.sizeBytes
          ? `${(mediaInfo.sizeBytes / 1048576).toFixed(1)} Mio`
          : "taille ?";
        const mbps = mediaInfo.sizeBytes && duration > 0
          ? ` · ${((mediaInfo.sizeBytes * 8) / duration / 1e6).toFixed(1)} Mb/s`
          : "";
        console.info(`[media] ${mediaInfo.url}`);
        console.info(`[media] ${sizeTxt} · ${mediaInfo.kind ?? "?"} · ${formatSec(duration)}${mbps}`);
        for (const v of this.availableStreams.video) {
          console.info(`[media] vidéo #${v.index} ${v.codec} ${v.width}x${v.height}${v.selected ? " (sélectionnée)" : ""}`);
        }
        for (const a of this.availableStreams.audio) {
          console.info(`[media] audio #${a.index} ${a.codec} ${a.channelCount}ch ${a.sampleRate}Hz${a.selected ? " (sélectionnée)" : ""}`);
        }
        console.info("[debug] stats à la demande : __averaDebug.stats() · périodiques : ?debug=1");
      } catch {}
      console.log(
        "%cFile information:",
        "font-weight: bold; font-size: x-large;",
      );
      console.log("Duration:\n", duration);
      console.log("Available streams:\n", this.availableStreams);
      console.log("Container Metadata:\n", metadata);
      console.log("Chapters:\n", chapters);

      // Audio
      if (this.audioStreamIndex != -1) {
        // Setup audio buffer
        await this.setupAudioDecoder();
      }
      // Video
      if (this.videoStreamIndex != -1) {
        await this.setupVideoDecoder();
      }
      // (Pas de canvas ici : render-worker dimensionne seul par frame.)
    } catch (error) {
      console.error("Error initializing media:", error);
      self.postMessage({ type: "error", message: error.message });
    }
  }

  async openSeekableSource(videoURL, generation) {
    await this.cleanupSource();
    // L'I/O vit dans demux-worker : ici on ne retient que l'URL (résolue).
    // Le HEAD + Range + VFS ont lieu dans demux.open (mêmes erreurs).
    this._openUrl = new URL(videoURL, self.location.href).href;
    this.sourceName = `source-${generation}`;
  }

  async cleanupSource() {
    // Fermeture côté demux-worker (best-effort) + reset du token local.
    try {
      this.demuxGen = (this.demuxGen ?? 0) + 1;
      await this.demuxCall("close", { gen: this.demuxGen });
    } catch {
      // Déjà parti après un init/reinit raté.
    }
    this.formatContext = null;
    this.sourceName = null;
    // Scan sous-titres en cours : plus rien à faire sur l'ancienne source.
    try { this._subScan?.terminate(); } catch {}
    this._subScan = null;
    this._subScanToken = (this._subScanToken ?? 0) + 1;
    this.subtitleCues = [];
  }

  streamTimestamp(seconds, streamIndex) {
    if (streamIndex === -1) return Math.floor(seconds * this.libav.AV_TIME_BASE);
    const stream = this.streams[streamIndex];
    return Math.max(
      0,
      Math.floor(seconds * stream.time_base_den / stream.time_base_num),
    );
  }

  packetTimeSeconds(packet) {
    if (!packet || packet.pts == null || packet.pts < 0) return null;
    return (packet.pts * packet.time_base_num) / packet.time_base_den;
  }

  frameTimeSeconds(frame) {
    if (frame instanceof VideoFrame || frame instanceof AudioData) {
      return frame.timestamp == null ? null : frame.timestamp / 1000000;
    }
    if (!frame || frame.pts == null || frame.pts < 0) return null;
    if (frame.time_base_num && frame.time_base_den) {
      return (frame.pts * frame.time_base_num) / frame.time_base_den;
    }
    return null;
  }

  frameDurationSeconds(frame) {
    if (frame instanceof AudioData) {
      return frame.duration != null
        ? frame.duration / 1000000
        : frame.numberOfFrames / frame.sampleRate;
    }
    if (frame && frame.nb_samples && frame.sample_rate) {
      return frame.nb_samples / frame.sample_rate;
    }
    return 0;
  }

  audioBufferSeconds() {
    if (!this.ringbuffer || !this.channelCount || !this.audioSampleRate) return 0;
    const usedBufferElements =
      this.ringbuffer.capacity() - this.ringbuffer.available_write();
    return usedBufferElements / (this.channelCount * this.audioSampleRate);
  }

  drainAudioRingBuffer() {
    if (this.ringbuffer) {
      this.ringbuffer.pop(new Float32Array(this.ringbuffer.available_read()));
    }
  }

  closeVideoFrames() {
    this.videoFrameBuffer.forEach((frame) => frame.close());
    this.videoFrameBuffer = [];
    this.postRenderClear();
  }

  async resetDecodersForSeek() {
    if (this.WCVideoDecoder && this.WCVideoDecoder.state === "configured") {
      this.WCVideoDecoder.reset();
      if (this.videoConfig) this.WCVideoDecoder.configure(this.videoConfig);
    } else if (this.VideoDecoderCodecContext) {
      await this.libav.avcodec_flush_buffers(this.VideoDecoderCodecContext);
    }
    if (this.WCAudioDecoder && this.WCAudioDecoder.state === "configured") {
      this.WCAudioDecoder.reset();
      if (this.audioConfig) this.WCAudioDecoder.configure(this.audioConfig);
    } else if (this.AudioDecoderCodecContext) {
      await this.libav.avcodec_flush_buffers(this.AudioDecoderCodecContext);
    }
    if (this.feedAudioDecoderTimeout) {
      clearTimeout(this.feedAudioDecoderTimeout);
      this.feedAudioDecoderTimeout = null;
    }
    this.videoFillInProgress = false;
    this.audioFillInProgress = false;
    this.queueFillInProgress = false;
  }

  async resetPipelineForSeek() {
    this.cancelRenderLoop();
    await this.resetDecodersForSeek();
    this.clearPacketQueues();
    this.closeVideoFrames();
    this.drainAudioRingBuffer();
    this.fileEnded = false;
  }

  async refillUntilPacketsAvailable(queue, serial, timeoutMs = 1500) {
    const start = performance.now();
    while (queue.length === 0 && !this.fileEnded && serial === this.seekSerial) {
      await this.readDemuxPackets(256 * 1024, serial);
      if (queue.length > 0 || this.fileEnded) break;
      if (performance.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 5));
    }
    return queue.length > 0;
  }

  async prerollVideoTo(targetSeconds, serial) {
    if (this.videoStreamIndex === -1) return targetSeconds;
    const targetUs = targetSeconds * 1000000;
    const start = performance.now();
    let previousFrame = null;
    // Sans _priming, feedVideoDecoder jette tout pendant isSeeking : la boucle
    // tournait 2 s à vide (freeze + spam) sans jamais choisir la frame.
    const wasPriming = this._priming;
    this._priming = true;

    try {
    while (serial === this.seekSerial && performance.now() - start < 2000) {
      while (this.videoFrameBuffer.length > 0) {
        const frame = this.videoFrameBuffer[0];
        if (frame.timestamp <= targetUs) {
          if (previousFrame) previousFrame.close();
          previousFrame = this.videoFrameBuffer.shift();
          continue;
        }

        const previousDelta = previousFrame
          ? Math.abs(previousFrame.timestamp - targetUs)
          : Number.POSITIVE_INFINITY;
        const nextDelta = Math.abs(frame.timestamp - targetUs);
        if (previousFrame && previousDelta <= nextDelta) {
          this.videoFrameBuffer.unshift(previousFrame);
          return previousFrame.timestamp / 1000000;
        }

        if (previousFrame) previousFrame.close();
        return frame.timestamp / 1000000;
      }

      await this.feedVideoDecoder();
      await new Promise((r) => setTimeout(r, 5));
      if (this.fileEnded) break;
    }

    if (previousFrame) {
      this.videoFrameBuffer.unshift(previousFrame);
      return previousFrame.timestamp / 1000000;
    }
    return targetSeconds;
    } finally {
      this._priming = wasPriming;
    }
  }

  async primeAudioBuffer(serial, targetSeconds = 0.45) {
    if (this.audioStreamIndex === -1 || !this.ringbuffer) return;
    // C'est le SEUL moment où on nourrit les décodeurs pendant un seek :
    // le levier _priming le permet (sinon feed* jette tout en isSeeking).
    const wasPriming = this._priming;
    this._priming = true;
    try {
      const start = performance.now();
      while (
        serial === this.seekSerial &&
        !this.fileEnded &&
        this.audioBufferSeconds() < targetSeconds &&
        performance.now() - start < 2000
      ) {
        await this.feedAudioDecoder();
        if (this.audioBufferSeconds() >= targetSeconds) break;
        await this.refillUntilPacketsAvailable(this.audioPacketQueue, serial, 250);
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      this._priming = wasPriming;
    }
  }

  async showInitialFrame() {
    if (this.videoStreamIndex === -1) return;
    const serial = this.seekSerial;
    const wasPriming = this._priming;
    this._priming = true;
    try {
      await this.refillUntilPacketsAvailable(this.videoPacketQueue, serial, 1000);
      await this.feedVideoDecoder();
      const start = performance.now();
      while (this.videoFrameBuffer.length === 0 && performance.now() - start < 1000) {
        await this.feedVideoDecoder();
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      this._priming = wasPriming;
    }
    if (this.videoFrameBuffer.length > 0) {
      this.pausedVideoTime = this.videoFrameBuffer[0].timestamp / 1000;
      this.renderVideo();
    }
  }

  async seek(seconds, videoTimeStart) {
    const serial = ++this.seekSerial;
    self.postMessage({ type: "buffering", buffering: true });
    if (!this.formatContext) {
      console.warn("Format context not initialized");
      self.postMessage({ type: "buffering", buffering: false });
      return;
    }

    this.isSeeking = true;
    await this.resetPipelineForSeek();
    var seekStream =
      this.videoStreamIndex != -1
        ? this.videoStreamIndex
        : this.audioStreamIndex != -1
          ? this.audioStreamIndex
          : -1;
    const timestamp = this.streamTimestamp(seconds, seekStream);

    let ret = await this.libav.av_seek_frame(
      this.formatContext,
      seekStream,
      timestamp,
      0,
      this.libav.AVSEEK_FLAG_BACKWARD,
    );
    if (ret < 0) {
      // Some demuxers behave better with avformat_seek_file's bounded helper.
      ret = await this.libav.avformat_seek_file_max(
        this.formatContext,
        seekStream,
        timestamp,
        0,
        this.libav.AVSEEK_FLAG_BACKWARD,
      );
    }
    if (ret < 0) {
      console.error("Error seeking:", await this.libav.ff_error(ret));
      this.isSeeking = false;
      self.postMessage({ type: "buffering", buffering: false });
      return;
    }

    if (serial !== this.seekSerial) return;
    this.clearPacketQueues();
    this.closeVideoFrames();
    this.drainAudioRingBuffer();
    this.fileEnded = false;
    this.audioPrerollTargetSeconds = this.audioStreamIndex !== -1 ? seconds : null;

    this.pausedVideoTime = seconds * 1000;
    this.videoTimeStart = performance.now();
    this.isSeeking = false;

    var queue =
      this.audioStreamIndex != -1
        ? this.audioPacketQueue
        : this.videoPacketQueue; // audio is more accurate because of more data
    const hasPackets = await this.refillUntilPacketsAvailable(queue, serial);
    if (!hasPackets || serial !== this.seekSerial) {
      console.warn("No packets available after seek");
      self.postMessage({ type: "buffering", buffering: false });
      return;
    }
    let packet = queue[0];
    const time = this.packetTimeSeconds(packet) ?? seconds;

    console.log(
      "seeked to",
      time,
      "seconds (asked for",
      seconds,
      ")\ntimestamp from",
      this.audioStreamIndex != -1 ? "audio" : "video",
    );

    const displayTime = await this.prerollVideoTo(seconds, serial);
    if (serial !== this.seekSerial) return;
    console.log(
      "displaying seek frame at",
      displayTime,
      "seconds (delta",
      displayTime - seconds,
      ")",
    );
    this.pausedVideoTime = displayTime * 1000;
    this.videoTimeStart = performance.now();
    this.audioPrerollTargetSeconds = this.audioStreamIndex !== -1 ? displayTime : null;
    await this.primeAudioBuffer(serial);
    if (serial !== this.seekSerial) return;
    this.pausedVideoTime = displayTime * 1000;
    this.videoTimeStart = performance.now();
    this.schedulePipelinePump();
    self.postMessage({ type: "buffering", buffering: false });
    self.postMessage({ type: "offsetMediaTime", mediaTime: displayTime });
    this.scheduleRenderLoop();
  }

  async changeStream(streamType, streamIndex) {
    const tSwitch = performance.now();
    const serial = ++this.seekSerial;
    console.log(`Changing ${streamType} stream to index ${streamIndex}`);
    self.postMessage({ type: "buffering", buffering: true });
    this.isSeeking = true;
    this.cancelRenderLoop();

    // Reset (pas flush) l'autre décodeur : un flush pend pour toujours sur un
    // décodeur coincé, et la position saute de toute façon (seek derrière) donc
    // les frames en vol sont périmées. Miroir de resetDecodersForSeek.
    if (streamType === "audio" && this.WCVideoDecoder) {
      try {
        if (this.WCVideoDecoder.state == "configured") {
          this.WCVideoDecoder.reset();
          if (this.videoConfig) this.WCVideoDecoder.configure(this.videoConfig);
        }
      } catch (e) { console.warn("video reset on audio switch:", e); }
    } else if (streamType === "video") {
      try {
        if (this.WCAudioDecoder && this.WCAudioDecoder.state == "configured") {
          this.WCAudioDecoder.reset();
          if (this.audioConfig) this.WCAudioDecoder.configure(this.audioConfig);
        } else if (this.AudioDecoderCodecContext) {
          await this.libav.avcodec_flush_buffers(this.AudioDecoderCodecContext);
        }
      } catch (e) { console.warn("audio reset on video switch:", e); }
      if (this.feedAudioDecoderTimeout) {
        clearTimeout(this.feedAudioDecoderTimeout);
        this.feedAudioDecoderTimeout = null;
      }
    }

    const currentTime = this.currentVideoTime() / 1000;
    // Fige l'horloge pendant l'opération : le décodeur logiciel (AC-3 WASM)
    // peut mettre >1 s ; sans ça le temps mural avance et on revient en
    // arrière à l'ancrage (saut/rejeu audible).
    this.pausedVideoTime = currentTime * 1000;
    this.videoTimeStart = performance.now();

    if (streamType === "audio") {
      this.audioStreamIndex = streamIndex;
      await this.cleanupAudio();
      await this.setupAudioDecoder();
    } else if (streamType === "video") {
      this.videoStreamIndex = streamIndex;
      await this.cleanupVideo();
      await this.setupVideoDecoder();
      // (Dimensionnement canvas : render-worker, par frame.)
    } else {
      console.warn(`Unknown stream type: ${streamType}`);
      this.isSeeking = false;
      return;
    }

    // Update stream selection in availableStreams
    if (this.availableStreams[streamType]) {
      for (const stream of this.availableStreams[streamType]) {
        stream.selected = stream.index === streamIndex;
      }
    }

    // Reset fileEnded so refill can read new packets
    this.fileEnded = false;

    // Seek demuxer to current playback position
    let seekStream =
      this.videoStreamIndex != -1
        ? this.videoStreamIndex
        : this.audioStreamIndex;
    let seekRes = 0;
    if (seekStream != -1 && this.formatContext) {
      let timebase =
        this.streams[seekStream].time_base_den /
        this.streams[seekStream].time_base_num;
      let timestamp = currentTime * timebase;
      if (this._openCache?.kind === "mp4" && streamType === "audio") {
        // Pas d'attente du round-trip (le démux MP4 est synchrone ; un read
        // envoyé après ce message verra déjà le curseur). Gain ~0,3-1 s.
        seekRes = this.libav.avformat_seek_file_nowait(
          this.formatContext, seekStream, timestamp,
        );
      } else {
        seekRes = await this.libav.avformat_seek_file_max(
          this.formatContext,
          seekStream,
          timestamp,
          0,
          0,
        );
      }
      if (seekRes < 0) {
        console.error(
          "Error seeking during stream change:",
          await this.libav.ff_error(seekRes),
        );
      }
    }

    // Clear old data and refill from seeked position
    this.clearPacketQueues();
    this.videoFrameBuffer.forEach((frame) => frame.close());
    this.videoFrameBuffer = [];
    this.postRenderClear();
    if (this.ringbuffer) {
      this.ringbuffer.pop(new Float32Array(this.ringbuffer.available_read()));
    }

    var queue =
      this.audioStreamIndex != -1
        ? this.audioPacketQueue
        : this.videoPacketQueue;
    let hasPackets = await this.refillUntilPacketsAvailable(queue, serial, 1500);
    if (!hasPackets && serial === this.seekSerial) {
      // 2e chance : le décodeur SW ou un read RPC ont pu saturer le worker.
      hasPackets = await this.refillUntilPacketsAvailable(queue, serial, 5000);
    }
    if (serial !== this.seekSerial) return;
    if (!hasPackets || queue.length == 0) {
      console.warn("No packets available after stream change — reprise sans amorçage");
      this.isSeeking = false;
      this.audioPrerollTargetSeconds = null;
      this.pausedVideoTime = currentTime * 1000;
      this.videoTimeStart = performance.now();
      self.postMessage({ type: "buffering", buffering: false });
      self.postMessage({ type: "offsetMediaTime", mediaTime: currentTime });
      if (this.isPlaying) {
        this._ringMin = null;
        this._playStartedAt = performance.now();
        this.startAudioRefillTimer();
        this.schedulePipelinePump();
      }
      this.scheduleRenderLoop();
      console.info(`[stream] ${streamType} → ${streamIndex} échec d'amorçage (reprise)`);
      return;
    }

    // Reprise : ancrage commun (horloge vidéo, preroll audio, offset main).
    // Pour un changement AUDIO seul, on ne fait PAS de préroll vidéo : sur du
    // 4K60 en décodage logiciel, décoder le GOP jusqu'à la position coûtait
    // plusieurs secondes de freeze (le préroll tournait même 2 s à vide avant
    // le correctif _priming). L'audio repart à currentTime ; la vidéo re-décode
    // depuis le keyframe et rattrape via la présentation (frames périmées
    // jetées, l'ancienne image reste affichée entre-temps).
    let displayTime = currentTime;
    if (streamType !== "audio") {
      displayTime = await this.prerollVideoTo(currentTime, serial);
      if (serial !== this.seekSerial) return;
    }
    this.pausedVideoTime = displayTime * 1000;
    if (this.isPlaying) {
      this.videoTimeStart = performance.now();
    }
    this.audioPrerollTargetSeconds = this.audioStreamIndex !== -1 ? displayTime : null;
    await this.primeAudioBuffer(serial);
    if (serial !== this.seekSerial) return;
    this.isSeeking = false;
    self.postMessage({ type: "buffering", buffering: false });
    self.postMessage({ type: "offsetMediaTime", mediaTime: displayTime });

    // Restart decoder feeds (cleanupAudio a arrêté le timer de refill)
    if (this.isPlaying) {
      this._ringMin = null;
      this._playStartedAt = performance.now();
      this.startAudioRefillTimer();
      this.schedulePipelinePump();
    }
    this.scheduleRenderLoop();
    console.info(
      `[stream] ${streamType} → ${streamIndex} prêt en ${Math.round(performance.now() - tSwitch)} ms`,
    );
  }

  // Sélection sous-titres : scan complet sur session dédiée (curseurs A/V
  // intacts), décodage en cues absolues (le seek n'a rien à refaire).
  // Léger et sans seek : pas de buffering, pas de reset décodeurs.
  async selectSubtitle(streamIndex) {
    this.subtitleStreamIndex = streamIndex;
    this.subtitleCues = [];
    // Un scan précédent (ou un changement de piste) annule le précédent.
    try { this._subScan?.terminate(); } catch {}
    this._subScan = null;
    if (streamIndex === -1 || streamIndex == null) {
      self.postMessage({ type: "subtitleCues", cues: [] });
      return;
    }
    const st = this.streams[streamIndex];
    const family = st?.codecpar?.family ?? "";
    const parse = family === "srt" ? parseSrtPacket
      : family === "ass" ? parseAssPacket
      : family === "tx3g" ? parseTx3gSample : null;
    if (!parse) {
      console.warn(`[sub] famille non supportée : ${family || "?"} (texte seul v1)`);
      self.postMessage({ type: "subtitleCues", cues: [] });
      return;
    }
    // Scan dans un WORKER DÉDIÉ : le démux de lecture n'est jamais bloqué
    // (le faire ici sérialisait le mutex RPC pendant des secondes → audio
    // affamé, dérive, stall — vu sur un épisode de 24 min).
    try {
      const worker = new Worker(new URL("./sub-scan-worker.js", import.meta.url), { type: "module" });
      this._subScan = worker;
      const token = (this._subScanToken = (this._subScanToken ?? 0) + 1);
      worker.onmessage = (e) => {
        const d = e.data;
        if (token !== this._subScanToken || this._subScan !== worker) return;
        if (d?.type === "cues") {
          const cues = [];
          for (const p of d.packets ?? []) {
            const c = packetToCue(p, parse(p.data));
            if (c) cues.push(c);
          }
          cues.sort((a, b) => a.startNs - b.startNs);
          this.subtitleCues = cues;
          console.log(`[sub] piste ${streamIndex} (${family}) : ${cues.length} cues en ${d.ms} ms`);
          self.postMessage({ type: "subtitleCues", cues });
        } else if (d?.type === "error") {
          console.warn("[sub] scan impossible:", d.error);
          self.postMessage({ type: "subtitleCues", cues: [] });
        }
        try { worker.terminate(); } catch {}
        if (this._subScan === worker) this._subScan = null;
      };
      worker.onerror = (err) => {
        console.warn("[sub] scan worker:", err?.message ?? err);
        if (token === this._subScanToken) self.postMessage({ type: "subtitleCues", cues: [] });
        try { worker.terminate(); } catch {}
        if (this._subScan === worker) this._subScan = null;
      };
      worker.postMessage({ type: "start", url: this._openUrl, trackIdx: streamIndex });
    } catch (e) {
      console.warn("[sub] scan impossible:", e?.message ?? e);
      self.postMessage({ type: "subtitleCues", cues: [] });
    }
  }

  async cleanupAudio() {
    this.stopAudioRefillTimer();
    if (this.WCAudioDecoder) {
      if (this.WCAudioDecoder.state == "configured")
        this.WCAudioDecoder.close();
      this.WCAudioDecoder = null;
    }
    this.audioUseWebCodecs = false;
    this.audioConfig = null;
    if (this.AudioDecoderCodecContext) {
      await this.libav.ff_free_decoder(
        this.AudioDecoderCodecContext,
        this.AudioDecoderPacket,
        this.AudioDecoderFrame,
      );
      this.AudioDecoderCodecContext = null;
      this.AudioDecoderPacket = null;
      this.AudioDecoderFrame = null;
    }
    if (this.feedAudioDecoderTimeout) {
      clearTimeout(this.feedAudioDecoderTimeout);
      this.feedAudioDecoderTimeout = null;
    }

    this.audioPacketQueue = [];

    if (this.ringbuffer) {
      this.ringbuffer.pop(new Float32Array(this.ringbuffer.available_read()));
    }
  }

  async setupAudioDecoder() {
    // Try to setup WebCodecs AudioDecoder, fallback to libav if not supported
    this.audioUseWebCodecs = false;
    var codecpar = await this.libav.ff_copyout_codecpar(
      this.streams[this.audioStreamIndex].codecpar,
    );
    this.audioSampleRate = codecpar.sample_rate;
    this.channelCount = codecpar.channels;

    let sampleCountIn500ms =
      this.DATA_BUFFER_DURATION * this.audioSampleRate * this.channelCount;
    this.sharedArrayBuffer = RingBuffer.getStorageForCapacity(
      sampleCountIn500ms,
      Float32Array,
    );
    this.ringbuffer = new RingBuffer(this.sharedArrayBuffer, Float32Array);

    const audioConfig = await LibAVJSWebCodecs.audioStreamToConfig(
      this.streams[this.audioStreamIndex].codecpar,
    );
    this.audioConfig = audioConfig;
    if ((await AudioDecoder.isConfigSupported(audioConfig)).supported) {
      this.audioUseWebCodecs = true;
      this.WCAudioDecoder = new AudioDecoder({
        output: this.bufferAudioSamples.bind(this),
        error: (e) => {
          if (e.name == "NotSupportedError") {
            console.warn(
              "Falling back to libav audio decoding due to NotSupportedError, should not happen normally.",
            );
            this.setupFallbackAudioDecoder();
          } else {
            console.error("AudioDecoder error:", e);
          }
        },
      });
      this.WCAudioDecoder.configure(audioConfig);
    } else {
      await this.setupFallbackAudioDecoder();
    }
    self.postMessage({
      type: "audioConfig",
      channelCount: this.channelCount,
      sampleRate: this.audioSampleRate,
      sharedArrayBuffer: this.sharedArrayBuffer,
    });
  }

  async setupFallbackAudioDecoder() {
    this.audioUseWebCodecs = false;
    this._audioDebugCount = 0;
    this._audioDecodeWarn = 0;
    if (this.WCAudioDecoder) {
      if (this.WCAudioDecoder.state == "configured")
        this.WCAudioDecoder.close();
      this.WCAudioDecoder = null;
    }
    const streamInfo = this.streams[this.audioStreamIndex];
    [
      ,
      this.AudioDecoderCodecContext,
      this.AudioDecoderPacket,
      this.AudioDecoderFrame,
    ] = await this.libav.ff_init_decoder(
      streamInfo.codec_id,
      streamInfo.codecpar,
    );
    console.log(
      `[audio] libav decoder init: codec=${streamInfo.codec_id} idx=${this.audioStreamIndex}`,
      `ch=${this.channelCount} sr=${this.audioSampleRate}`,
    );
  }

  async cleanupVideo() {
    if (this.WCVideoDecoder) {
      if (this.WCVideoDecoder.state == "configured")
        this.WCVideoDecoder.close();
      this.WCVideoDecoder = null;
    }
    if (this.VideoDecoderCodecContext) {
      await this.libav.ff_free_decoder(
        this.VideoDecoderCodecContext,
        this.VideoDecoderPacket,
        this.VideoDecoderFrame,
      );
      this.VideoDecoderCodecContext = null;
      this.VideoDecoderPacket = null;
      this.VideoDecoderFrame = null;
    }
    this.videoUseWebCodecs = false;
    this.videoConfig = null;
    this.videoPacketQueue = [];
    this.PACKET_QUEUE_BYTES_VIDEO = 0;
    this.videoFrameBuffer.forEach((frame) => frame.close());
    this.videoFrameBuffer = [];
    this.postRenderClear();
  }

  /** État couleur/HDR du flux vidéo courant → render worker (tone mapping).
   *  Lu depuis codecpar.color (conteneur + VUI, cf. demux-compat). */
  sendColorState() {
    const c = this.streams?.[this.videoStreamIndex]?.codecpar?.color ?? null;
    const state = {
      mode: hdrMode(c),
      bt2020: c?.primaries === "bt2020" || String(c?.matrix ?? "").startsWith("bt2020"),
      peak: 203,
      maxCLL: c?.maxCLL ?? 0,
    };
    try { this.renderPort?.postMessage({ type: "color", state }); } catch {}
    if (state.mode !== "sdr") {
      console.log(`[hdr] flux ${state.mode}${state.bt2020 ? " BT.2020" : ""} → tone mapping SDR (${state.peak} nits)`);
    }
  }

  async setupVideoDecoder() {
    this.videoUseWebCodecs = false;
    let videoConfig = await LibAVJSWebCodecs.videoStreamToConfig(
      this.streams[this.videoStreamIndex].codecpar,
    );
    // Contournement bug Firefox #2054811 (étirement VA-API sur H264 paddé,
    // fix branche 157) : décodage software forcé (toggle/?sw=1/auto FF<157).
    // https://bugzilla.mozilla.org/show_bug.cgi?id=2054811
    if (this._forceSW) {
      videoConfig = { ...videoConfig, hardwareAcceleration: "prefer-software" };
      console.log("[decode] software forcé (contournement Firefox #2054811)");
    }
    this.videoConfig = videoConfig;
    this.sendColorState();
    let webCodecsSupported = false;
    try {
      webCodecsSupported = (await VideoDecoder.isConfigSupported(videoConfig)).supported;
    } catch (e) {
      console.warn("WebCodecs video config not supported, using LibAV.js fallback:", e);
    }
    const vs = this.availableStreams.video.find(
      (v) => v.index === this.videoStreamIndex,
    );
    if (webCodecsSupported) {
      this.videoUseWebCodecs = true;
      this.WCVideoDecoder = new VideoDecoder({
        output: this.bufferVideoFrame.bind(this),
        error: (e) => console.error("VideoDecoder error:", e),
      });
      this.WCVideoDecoder.configure(videoConfig);
      const px = Number(vs?.width ?? 0) * Number(vs?.height ?? 0);
      console.info(
        `[video] ${videoConfig.codec} ${vs?.width ?? "?"}x${vs?.height ?? "?"}` +
          ` → WebCodecs (${this._forceSW ? "software forcé" : "HW préféré"}),` +
          ` frame max ${this.frameBufferMax()}, decQ max ${this.decoderQueueMax()}`,
      );
      if (px >= 3840 * 2160 * 0.9 && !this._forceSW) {
        console.warn(
          `[video] source ${vs?.width}x${vs?.height} : décodage + upload lourds` +
            " — les frames en retard seront jetées (pas de désynchro audio)",
        );
      }
    } else {
      console.warn(
        `[video] ${videoConfig.codec} non supporté par WebCodecs → décodeur logiciel WASM (lent)`,
      );
      await this.setupFallbackVideoDecoder();
    }
  }

  async setupFallbackVideoDecoder() {
    this.videoUseWebCodecs = false;
    if (this.WCVideoDecoder) {
      if (this.WCVideoDecoder.state == "configured") this.WCVideoDecoder.close();
      this.WCVideoDecoder = null;
    }
    [
      ,
      this.VideoDecoderCodecContext,
      this.VideoDecoderPacket,
      this.VideoDecoderFrame,
    ] = await this.libav.ff_init_decoder(
      this.streams[this.videoStreamIndex].codec_id,
      this.streams[this.videoStreamIndex].codecpar,
    );
    console.log("Using LibAV.js video decoder fallback");
  }

  clampByte(value) {
    return value < 0 ? 0 : value > 255 ? 255 : value;
  }

  frameTimestampUs(frame) {
    if (frame.pts == null || frame.pts < 0) return 0;
    const stream = this.streams[this.videoStreamIndex];
    const timeBaseNum = (frame.time_base_num && frame.time_base_den) ? frame.time_base_num : (stream?.time_base_num || 1);
    const timeBaseDen = (frame.time_base_num && frame.time_base_den) ? frame.time_base_den : (stream?.time_base_den || 1000000);
    return Math.round((frame.pts * timeBaseNum * 1000000) / timeBaseDen);
  }

  packetTimestampUs(packet) {
    const seconds = this.packetTimeSeconds(packet);
    return seconds == null ? 0 : Math.round(seconds * 1000000);
  }

  planeSample(frame, plane, x, y, fallbackStride) {
    if (frame.layout) {
      const layout = frame.layout[plane];
      return frame.data[layout.offset + y * layout.stride + x];
    }

    const data = frame.data[plane];
    if (Array.isArray(data[0])) return data[y][x];
    const stride = fallbackStride;
    return data[y * stride + x];
  }

  chromaSampleBilinear(frame, plane, cx, cy, chromaWidth, chromaHeight, fallbackStride) {
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(x0 + 1, chromaWidth - 1);
    const y1 = Math.min(y0 + 1, chromaHeight - 1);
    const fx = cx - x0;
    const fy = cy - y0;

    const s00 = this.planeSample(frame, plane, x0, y0, fallbackStride);
    const s10 = this.planeSample(frame, plane, x1, y0, fallbackStride);
    const s01 = this.planeSample(frame, plane, x0, y1, fallbackStride);
    const s11 = this.planeSample(frame, plane, x1, y1, fallbackStride);

    const top = (1 - fx) * s00 + fx * s10;
    const bot = (1 - fx) * s01 + fx * s11;
    return (1 - fy) * top + fy * bot;
  }

  async libavNv12FrameToRgbaVideoFrame(frame) {
    const width = frame.width;
    const height = frame.height;
    const rgba = new Uint8Array(width * height * 4);
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);

    let lumaOffset = 0, lumaStride = width;
    let uvOffset = 0, uvStride = width * 2;
    if (frame.layout) {
      lumaOffset = frame.layout[0].offset;
      lumaStride = frame.layout[0].stride;
      uvOffset = frame.layout[1].offset;
      uvStride = frame.layout[1].stride;
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const yy = frame.data[lumaOffset + y * lumaStride + x];
        const cx = x * 0.5;
        const cy = y * 0.5;
        const ux0 = Math.floor(cx);
        const uy0 = Math.floor(cy);
        const ux1 = Math.min(ux0 + 1, chromaWidth - 1);
        const uy1 = Math.min(uy0 + 1, chromaHeight - 1);
        const fx = cx - ux0;
        const fy = cy - uy0;

        const u00 = frame.data[uvOffset + uy0 * uvStride + ux0 * 2];
        const v00 = frame.data[uvOffset + uy0 * uvStride + ux0 * 2 + 1];
        const u10 = frame.data[uvOffset + uy0 * uvStride + ux1 * 2];
        const v10 = frame.data[uvOffset + uy0 * uvStride + ux1 * 2 + 1];
        const u01 = frame.data[uvOffset + uy1 * uvStride + ux0 * 2];
        const v01 = frame.data[uvOffset + uy1 * uvStride + ux0 * 2 + 1];
        const u11 = frame.data[uvOffset + uy1 * uvStride + ux1 * 2];
        const v11 = frame.data[uvOffset + uy1 * uvStride + ux1 * 2 + 1];

        const uTop = (1 - fx) * u00 + fx * u10;
        const uBot = (1 - fx) * u01 + fx * u11;
        const uu = (1 - fy) * uTop + fy * uBot;
        const vTop = (1 - fx) * v00 + fx * v10;
        const vBot = (1 - fx) * v01 + fx * v11;
        const vv = (1 - fy) * vTop + fy * vBot;

        const c = yy - 16;
        const d = uu - 128;
        const e = vv - 128;
        const out = (y * width + x) * 4;
        rgba[out] = this.clampByte((298 * c + 409 * e + 128) >> 8);
        rgba[out + 1] = this.clampByte((298 * c - 100 * d - 208 * e + 128) >> 8);
        rgba[out + 2] = this.clampByte((298 * c + 516 * d + 128) >> 8);
        rgba[out + 3] = 255;
      }
    }

    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
    const imageData = new ImageData(clamped, width, height);
    return this.imageDataToVideoFrame(imageData, this.frameTimestampUs(frame));
  }

  async libavYuv420FrameToRgbaVideoFrame(frame) {
    const width = frame.width;
    const height = frame.height;
    const rgba = new Uint8Array(width * height * 4);
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const yy = this.planeSample(frame, 0, x, y, width);
        const cx = x * 0.5;
        const cy = y * 0.5;
        const uu = this.chromaSampleBilinear(frame, 1, cx, cy, chromaWidth, chromaHeight, chromaWidth);
        const vv = this.chromaSampleBilinear(frame, 2, cx, cy, chromaWidth, chromaHeight, chromaWidth);
        const c = yy - 16;
        const d = uu - 128;
        const e = vv - 128;
        const out = (y * width + x) * 4;
        rgba[out] = this.clampByte((298 * c + 409 * e + 128) >> 8);
        rgba[out + 1] = this.clampByte((298 * c - 100 * d - 208 * e + 128) >> 8);
        rgba[out + 2] = this.clampByte((298 * c + 516 * d + 128) >> 8);
        rgba[out + 3] = 255;
      }
    }

    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
    const imageData = new ImageData(clamped, width, height);
    return this.imageDataToVideoFrame(imageData, this.frameTimestampUs(frame));
  }

  /** colorSpace WebCodecs du flux vidéo courant (null si SDR/inconnu). */
  currentVideoColor() {
    const c = this.streams?.[this.videoStreamIndex]?.codecpar?.color ?? null;
    if (!c || hdrMode(c) === "sdr") return null;
    return toWebCodecsColorSpace(c);
  }

  async libavFrameToVideoFrame(frame) {
    if (frame.format == null) {
      console.warn("libav frame has no format, skipping");
      return null;
    }

    if (frame.format === 0) {
      return await this.libavI420FrameToVideoFrame(frame);
    }

    if (frame.format === 23) {
      return await this.libavNv12FrameToVideoFrame(frame);
    }

    try {
      const yuv = LibAVJSWebCodecs.laFrameToVideoFrame(frame);
      const ts = yuv.timestamp;
      const bitmap = await createImageBitmap(yuv);
      yuv.close();
      return { bitmap, timestamp: ts, displayWidth: bitmap.width, displayHeight: bitmap.height, close() { bitmap.close() } };
    } catch (e) {
      console.warn("Bridge conversion failed for format", frame.format, "- trying manual fallback:", e);
      if (frame.format === 23) return await this.libavNv12FrameToRgbaVideoFrame(frame);
      if (frame.format === 0) return await this.libavYuv420FrameToRgbaVideoFrame(frame);
      return null;
    }
  }

  copyPlane(dst, dstOff, dstStride, src, srcOff, srcStride, width, rows, label) {
    if (srcStride === dstStride) {
      const len = dstStride * rows;
      dst.set(src.subarray(srcOff, srcOff + len), dstOff);
    } else {
      for (let y = 0; y < rows; y++) {
        const sOff = srcOff + y * srcStride;
        const dOff = dstOff + y * dstStride;
        for (let x = 0; x < width; x++) {
          dst[dOff + x] = src[sOff + x];
        }
      }
    }
  }

  async libavI420FrameToVideoFrame(frame) {
    const width = frame.width;
    const height = frame.height;
    const uvW = Math.ceil(width / 2);
    const uvH = Math.ceil(height / 2);
    const ySize = width * height;
    const uvSize = uvW * uvH;
    const cleanData = new Uint8Array(ySize + uvSize * 2);

    const l0 = frame.layout[0];
    const l1 = frame.layout[1];
    const l2 = frame.layout[2];

    this.copyPlane(cleanData, 0, width,
      frame.data, l0.offset, l0.stride, width, height);
    this.copyPlane(cleanData, ySize, uvW,
      frame.data, l1.offset, l1.stride, uvW, uvH);
    this.copyPlane(cleanData, ySize + uvSize, uvW,
      frame.data, l2.offset, l2.stride, uvW, uvH);

    const ts = this.frameTimestampUs(frame);
    const color = this.currentVideoColor();
    const vf = new VideoFrame(cleanData, {
      format: "I420",
      codedWidth: width,
      codedHeight: height,
      timestamp: ts,
      layout: [
        { offset: 0, stride: width },
        { offset: ySize, stride: uvW },
        { offset: ySize + uvSize, stride: uvW },
      ],
      ...(color ? { colorSpace: color } : {}),
    });
    if (color) {
      // HDR : conserver la VideoFrame (createImageBitmap la convertirigerait
      // en SDR 8 bits sans tone mapping) — le renderer WebGL mappe lui-même.
      return { source: vf, timestamp: ts, displayWidth: width, displayHeight: height, close() { try { vf.close(); } catch {} } };
    }
    const bitmap = await createImageBitmap(vf);
    vf.close();
    return { bitmap, timestamp: ts, displayWidth: width, displayHeight: height, close() { bitmap.close() } };
  }

  async libavNv12FrameToVideoFrame(frame) {
    const width = frame.width;
    const height = frame.height;
    const uvW = Math.ceil(width / 2) * 2;
    const uvH = Math.ceil(height / 2);
    const ySize = width * height;
    const uvSize = uvW * uvH;
    const cleanData = new Uint8Array(ySize + uvSize);

    const l0 = frame.layout[0];
    const l1 = frame.layout[1];

    this.copyPlane(cleanData, 0, width,
      frame.data, l0.offset, l0.stride, width, height);
    this.copyPlane(cleanData, ySize, uvW,
      frame.data, l1.offset, l1.stride, uvW, uvH);

    const ts = this.frameTimestampUs(frame);
    const color = this.currentVideoColor();
    const vf = new VideoFrame(cleanData, {
      format: "NV12",
      codedWidth: width,
      codedHeight: height,
      timestamp: ts,
      layout: [
        { offset: 0, stride: width },
        { offset: ySize, stride: uvW },
      ],
      ...(color ? { colorSpace: color } : {}),
    });
    if (color) {
      return { source: vf, timestamp: ts, displayWidth: width, displayHeight: height, close() { try { vf.close(); } catch {} } };
    }
    const bitmap = await createImageBitmap(vf);
    vf.close();
    return { bitmap, timestamp: ts, displayWidth: width, displayHeight: height, close() { bitmap.close() } };
  }

  async imageDataToVideoFrame(imageData, timestamp) {
    const bitmap = await createImageBitmap(imageData);
    return { bitmap, timestamp, displayWidth: bitmap.width, displayHeight: bitmap.height, close() { bitmap.close(); } };
  }

  // Communication with main thread

  async startOutput() {
    if (this.isPlaying) return;

    // Lancement « rapide » (juste chargé, ou re-init) : pré-remplir l'anneau
    // audio AVANT de démarrer l'horloge, sinon le worklet lit un anneau vide
    // → silence + partial read pendant ~0,5s → le compteur avance sur du vide
    // et la vidéo part en avance (petit décalage permanent).
    if (
      this.audioStreamIndex !== -1 &&
      this.ringbuffer &&
      this.audioBufferSeconds() < 0.3
    ) {
      const serial = this.seekSerial;
      await this.primeAudioBuffer(serial, 0.45);
      if (serial !== this.seekSerial) return; // seek arrivé pendant le prime
    }

    this.isPlaying = true;
    this._ringMin = null;
    this._slowWarned = false;
    this._slowCheckAt = performance.now();
    this._playStartedAt = performance.now();
    this.startAudioRefillTimer();
    // Use the first buffered frame's timestamp as the reference time,
    // so the stale check works even when frames start at non-zero pts.
    if (this.videoFrameBuffer.length > 0 && this.pausedVideoTime === 0) {
      this.pausedVideoTime = this.videoFrameBuffer[0].timestamp / 1000;
    }
    this.videoTimeStart = performance.now();
    self.postMessage({ type: "videoStatus", isPlaying: this.isPlaying });
    // Ré-ancre l'horloge audio sur le début réel (frames + anneau amorcé).
    // Sans ça, si l'AudioContext a démarré au clic (geste utilisateur) pendant
    // le prime (~0,5 s), son compteur avance sur du silence : la vidéo paraît
    // 0,5 s en retard et toutes ses frames sont jetées comme « périmées ».
    try {
      self.postMessage({
        type: "offsetMediaTime",
        mediaTime: (this.pausedVideoTime ?? 0) / 1000,
      });
    } catch {}
    this.scheduleRenderLoop();
    this.schedulePipelinePump();
  }

  stopOutput() {
    if (!this.isPlaying) return;

    this.isPlaying = false;
    this.stopAudioRefillTimer();
    this.pausedVideoTime =
      this.pausedVideoTime + (performance.now() - this.videoTimeStart);
    this.cancelRenderLoop();
    self.postMessage({ type: "videoStatus", isPlaying: this.isPlaying });
  }

  scheduleRenderLoop() {
    if (this.renderRafId !== null || !this.isPlaying || this.isSeeking) return;
    this.renderRafId = self.requestAnimationFrame(() => {
      this.renderRafId = null;
      this.renderVideoLoop();
    });
  }

  cancelRenderLoop() {
    if (this.renderRafId !== null) {
      self.cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }
  }

  /** Refill audio indépendant du rythme des frames vidéo (4K60 : le pompage
   * déclenché par chaque frame ne doit pas retarder l'anneau audio). */
  startAudioRefillTimer() {
    if (this._audioTimer || this.audioStreamIndex === -1) return;
    this._audioTimer = setInterval(() => {
      if (!this.isPlaying || this.isSeeking) return;
      void this.feedAudioDecoder();
      // Diagnostic : creux d'anneau = famine (audio décalé/perceptible).
      try {
        const ring = this.audioBufferSeconds();
        if (ring < (this._ringMin ?? Infinity)) this._ringMin = ring;
        if (ring < 0.3) {
          const now = performance.now();
          if (now - (this._lowRingWarnAt ?? 0) > 2000) {
            this._lowRingWarnAt = now;
            console.warn(
              `[audio] anneau bas ${ring.toFixed(2)}s` +
                ` (aQ=${this.audioPacketQueue.length},` +
                ` fill=${this.audioFillInProgress ? "en cours" : "libre"},` +
                ` refill=${Math.round(this._aRefillMs ?? 0)}ms,` +
                ` decQ=${this.WCAudioDecoder?.decodeQueueSize ?? "-"})`,
            );
          }
        }
      } catch {}
    }, 100);
  }

  stopAudioRefillTimer() {
    if (this._audioTimer) {
      clearInterval(this._audioTimer);
      this._audioTimer = null;
    }
  }

  async pumpPipeline() {
    if (!this.formatContext || this.isSeeking) return;
    // Fencing d'époque : si un seek a eu lieu pendant les awaits ci-dessous,
    // on abandonne (sinon l'ancien et le nouveau flux se mélangent : paquets
    // d'avant-seek nourris au décodeur reset → "needs a key chunk" + positions
    // atterrissant n'importe où — vu en beta surtout sans pause).
    const ep = this.seekSerial;
    // Audio et vidéo en parallèle : un refill audio lent (RPC démux) ne doit
    // pas retarder le décodage vidéo → frames en retard → drops en rafale.
    const jobs = [];
    if (this.audioStreamIndex !== -1) jobs.push(this.feedAudioDecoder());
    if (this.videoStreamIndex !== -1) jobs.push(this.feedVideoDecoder());
    await Promise.allSettled(jobs);
    if (ep !== this.seekSerial) return;
  }

  schedulePipelinePump() {
    if (this.pipelinePumpScheduled || this.isSeeking) return;
    this.pipelinePumpScheduled = true;
    // Macrotâche (pas microtâche) : une rafale de sorties décodeur ne doit
    // pas affamer les timers (refill audio, RPC) — vu sur 4K60.
    setTimeout(async () => {
      this.pipelinePumpScheduled = false;
      await this.pumpPipeline();
    }, 0);
  }

  // Time management

  updateMediaTime(pausedVideoTime, videoTimeStart) {
    // Message périmé : si le worker était saturé (grosse frame, GC), une
    // rafale d'updates anciens ferait reculer l'horloge → frames jetées et
    // dérive A/V transitoire. On garde le dernier état frais.
    // Date.now() est partagé page/worker (contrairement à performance.now()).
    const ageMs = Date.now() - videoTimeStart;
    if (this.isPlaying && ageMs > 750) {
      this._staleClockUpdates = (this._staleClockUpdates ?? 0) + 1;
      return;
    }
    const audioTimeMs = pausedVideoTime * 1000;
    this.lastAVDifference = audioTimeMs - this.currentVideoTime();
    // Pas d'alerte pendant la première seconde (l'horloge n'est pas encore
    // recalée sur le prime audio → faux positif à -0,5 s).
    const warming = performance.now() - (this._playStartedAt ?? 0) < 1500;
    if (!warming && Math.abs(this.lastAVDifference) > 100) {
      self.postMessage({
        type: "avDrift",
        driftMs: this.lastAVDifference,
      });
    }
    this.pausedVideoTime = audioTimeMs;
    // Ancre « maintenant » locale, recalée de l'âge du message : insensible
    // aux origines performance.now() distinctes page/worker.
    this.videoTimeStart = performance.now() - Math.max(0, ageMs);
  }

  currentVideoTime() {
    if (this.isPlaying) {
      return this.pausedVideoTime + (performance.now() - this.videoTimeStart);
    } else if (this.pausedVideoTime !== null) {
      return this.pausedVideoTime;
    } else {
      return 0;
    }
  }

  packetByteSize(packet) {
    return packet?.size || packet?.data?.byteLength || packet?.data?.length || 0;
  }

  enqueuePacket(type, packet) {
    if (type === "video") {
      this.videoPacketQueue.push(packet);
      this.PACKET_QUEUE_BYTES_VIDEO += this.packetByteSize(packet);
    } else {
      this.audioPacketQueue.push(packet);
      this.PACKET_QUEUE_BYTES_AUDIO += this.packetByteSize(packet);
    }
  }

  dequeuePacket(type) {
    const queue = type === "video" ? this.videoPacketQueue : this.audioPacketQueue;
    const packet = queue.shift();
    if (packet) {
      if (type === "video") {
        this.PACKET_QUEUE_BYTES_VIDEO = Math.max(
          0,
          this.PACKET_QUEUE_BYTES_VIDEO - this.packetByteSize(packet),
        );
      } else {
        this.PACKET_QUEUE_BYTES_AUDIO = Math.max(
          0,
          this.PACKET_QUEUE_BYTES_AUDIO - this.packetByteSize(packet),
        );
      }
    }
    return packet;
  }

  clearPacketQueues() {
    this.videoPacketQueue = [];
    this.audioPacketQueue = [];
    this.PACKET_QUEUE_BYTES_VIDEO = 0;
    this.PACKET_QUEUE_BYTES_AUDIO = 0;
  }

  needsMorePackets(type) {
    // Seuils d'origine uniquement (60 paquets / 16Mo). Tenté à deux reprises
    // de brider le démux (plafond au présent, puis oldest-gate) : à chaque fois
    // pire — ce décodeur exige un flux soutenu et meurt affamé (fatal
    // EncodingError après ~10s de disette, irréversible). Le démux ne suit QUE
    // ces compteurs ; la présentation (dû/périmé sur horloge saine) trie.
    if (type === "video") {
      return this.videoStreamIndex !== -1 &&
        this.videoPacketQueue.length < this.PACKET_QUEUE_MIN_SIZE &&
        this.PACKET_QUEUE_BYTES_VIDEO < this.PACKET_QUEUE_MAX_BYTES;
    }
    return this.audioStreamIndex !== -1 &&
      this.audioPacketQueue.length < this.PACKET_QUEUE_MIN_SIZE &&
      this.PACKET_QUEUE_BYTES_AUDIO < this.PACKET_QUEUE_MAX_BYTES;
  }

  async refillFrameQueues(want = null) {
    // Video step 1/4: fill videoPacketQueue with demuxed packets
    // Audio step 1/4: fill audioPacketQueue with demuxed packets
    if (this.isSeeking) this._warnSeekFeed("refill");
    if (this.queueFillInProgress || this.fileEnded) {
      return;
    }

    this.queueFillInProgress = true;
    try {
      await this.refillFrameQueuesInternal(want);
    } finally {
      this.queueFillInProgress = false;
    }
  }
  async refillFrameQueuesInternal(want = null) {
    // Video step 1/4: fill videoPacketQueue with demuxed packets
    // Audio step 1/4: fill audioPacketQueue with demuxed packets
    // `want` : ne remplir QUE la file demandée. Sans ça, l'audio attendait
    // que la file vidéo atteigne 60 paquets (4K : plusieurs RPC lents) →
    // refill de 1-2 s → anneau vidé. Le RPC read renvoie les deux files,
    // donc rien n'est perdu.
    const ep = this.seekSerial; // fencing d'époque (cf. pumpPipeline)
    const need = (t) => (want == null || want === t) && this.needsMorePackets(t);
    if (!need("video") && !need("audio")) {
      return;
    }
    if (!this.packet) {
      this.packet = await this.libav.av_packet_alloc();
    }
    if (!this.formatContext) {
      console.warn("Format context not initialized");
      return;
    }
    while (need("video") || need("audio")) {
      const gotPackets = await this.readDemuxPackets(512 * 1024);
      if (ep !== this.seekSerial) return; // seek entre-temps : on abandonne
      if (this.fileEnded) return;
      if (!gotPackets) break;
    }
  }

  async readDemuxPackets(limit, serial = this.seekSerial) {
    if (!this.packet) {
      this.packet = await this.libav.av_packet_alloc();
    }
    if (!this.formatContext) return;
    // Remplit par RPC : le demux retourne tout ce qu'il parse (borné ~2Mo/RPC),
    // on enfile (les seuils needsMorePackets bornent le staging côté decode).
    // Génération : ignore les réponses périmées (seek entre-temps).
    const gen = this.demuxGen ?? 0;
    const ep = this.seekSerial;
    let r;
    const tRpc = performance.now();
    try {
      r = await this.demuxCall("read", {
        gen,
        videoIdx: this.videoStreamIndex,
        audioIdx: this.audioStreamIndex,
      });
      this._readRpcMs = performance.now() - tRpc;
      this._readRpcs = (this._readRpcs ?? 0) + 1;
    } catch (e) {
      console.error("Error reading frame:", e?.message ?? e);
      return false;
    }
    if (ep !== this.seekSerial || serial !== this.seekSerial) return false; // périmé : on jette, on continue
    if (r.gen !== gen) return true; // périmé (seek entre-temps) : on ignore, on continue
    if (r.pos != null) this._demuxPos = r.pos; // debug beta (traçage EOF fantôme)
    if (r.eof) this.fileEnded = true;
    let gotPackets = false;
    for (const packet of r.video ?? []) {
      this.enqueuePacket("video", packet);
      gotPackets = true;
    }
    for (const packet of r.audio ?? []) {
      this.enqueuePacket("audio", packet);
      gotPackets = true;
    }
    return gotPackets;
  }

  /** Un seul avertissement par seconde (évite des centaines de lignes). */
  _warnSeekFeed(what) {
    const now = performance.now();
    this._seekFeedWarns = this._seekFeedWarns ?? {};
    if (now - (this._seekFeedWarns[what] ?? 0) > 1000) {
      this._seekFeedWarns[what] = now;
      console.warn(`feed ${what} called while seeking (jeté)`);
    }
  }

  async feedVideoDecoder() {
    // Video step 2/4: send the demuxed video packets to the video decoder
    if (this.isSeeking && !this._priming) {
      this._warnSeekFeed("video");
      return;
    }
    if (this.videoFillInProgress) return;
    this.videoFillInProgress = true;
    await this.feedVideoDecoderInternal();
    this.videoFillInProgress = false;
  }

  async feedVideoDecoderInternal() {
    try {
      // (fencing d'époque : voir pumpPipeline — un seek entre deux awaits
      // invalide tout ce qui suit)
      const ep = this.seekSerial;
      if (!this.formatContext) {
        console.warn("Format context not initialized");
        return;
      }
      if (this.videoStreamIndex === -1) {
        return;
      }
      if (this.videoUseWebCodecs && !this.WCVideoDecoder) {
        return;
      }
      if (!this.videoUseWebCodecs && !this.VideoDecoderCodecContext) {
        return;
      }
      if (this.videoFrameBuffer.length > this.FRAME_BUFFER_TARGET_SIZE) {
        return;
      }
      if (
        this.videoPacketQueue.length === 0 ||
        (this.audioStreamIndex !== -1 && this.audioPacketQueue.length === 0)
      ) {
        await this.refillFrameQueues("video");
        if (ep !== this.seekSerial) return; // seek entre-temps : paquets périmés
      }
      let packet = null;
      while (this.videoFrameBuffer.length < this.FRAME_BUFFER_TARGET_SIZE) {
        if (
          this.videoUseWebCodecs &&
          this.WCVideoDecoder &&
          this.WCVideoDecoder.decodeQueueSize >= this.decoderQueueMax()
        ) {
          break;
        }
        if (this.videoPacketQueue.length === 0) {
          await this.refillFrameQueues("video");
          if (ep !== this.seekSerial) return; // seek entre-temps : paquets périmés
          if (this.videoPacketQueue.length === 0) {
            break;
          }
        }
        packet = this.dequeuePacket("video");
        if (this.videoUseWebCodecs && this.WCVideoDecoder) {
          if (this.WCVideoDecoder.state !== "configured") break;
          const chunk = LibAVJSWebCodecs.packetToEncodedVideoChunk(
            packet,
            this.streams[this.videoStreamIndex],
          );
          this._vFed = (this._vFed ?? 0) + 1;
          this.WCVideoDecoder.decode(new EncodedVideoChunk(chunk));
        } else {
          const frames = await this.libav.ff_decode_multi(
            this.VideoDecoderCodecContext,
            this.VideoDecoderPacket,
            this.VideoDecoderFrame,
            [packet],
          );
          for (const frame of frames) {
            const timestamp = this.frameTimestampUs(frame) || this.packetTimestampUs(packet);
            const videoFrame = await this.libavFrameToVideoFrame(frame);
            if (videoFrame) this.bufferVideoFrame(videoFrame);
          }
        }
      }
    } catch (e) {
      console.error("Error decoding video data:", e);
    }
  }

  /** Taille approximative d'une frame décodée (YUV420 8 bits). */
  frameBytes() {
    const st = this.streams?.[this.videoStreamIndex];
    const w = Number(st?.codecpar?.width ?? 0);
    const h = Number(st?.codecpar?.height ?? 0);
    return w > 0 && h > 0 ? w * h * 1.5 : 0;
  }

  /** Plafond mémoire du tampon de frames (4K = 13,5 Mio → 11 frames). */
  frameBufferMax() {
    const b = this.frameBytes();
    if (!b) return this.FRAME_BUFFER_TARGET_SIZE + 8;
    return Math.max(
      this.FRAME_BUFFER_TARGET_SIZE,
      Math.min(24, Math.floor((160 * 1024 * 1024) / b)),
    );
  }

  /** Profondeur du décodeur WebCodecs. Un décodeur nourri au compte-gouttes
   * se coince (observé : sortie 3/s puis plus rien à 4 de profondeur) ; il
   * lui faut une file d'environ 1 s. Budget ~192 Mio (4K = 13,5 Mio/frame
   * → 14 ; 1080p → 24). */
  decoderQueueMax() {
    const b = this.frameBytes();
    if (!b) return this.DECODER_QUEUE_SIZE_MAX;
    return Math.max(
      8,
      Math.min(12, Math.floor((192 * 1024 * 1024) / b)),
    );
  }

  bufferVideoFrame(frame) {
    // Video step 3/4: add decoded video frame to the frame buffer
    if (this.isSeeking && !this._priming)
      console.warn(
        "bufferVideoFrame called while seeking (output of video decoder)",
      );
    this._vOut = (this._vOut ?? 0) + 1;
    this._lastVOutT = performance.now();
    this.videoFrameBuffer.push(frame);
    // Plafond mémoire. Ne JAMAIS jeter une frame en retard à l'entrée : quand
    // le décodeur 4K logiciel tourne à ~17 fps, toutes les frames sont en
    // retard et le drop sec gelait la vidéo pour de bon. Ici : si la tête est
    // en retard on l'écarte (on se rapproche du direct), sinon on jette la fin
    // (frames futures) pour préserver la tête due.
    const max = this.frameBufferMax();
    while (this.videoFrameBuffer.length > max) {
      let late = false;
      try {
        // Ne jeter la tête que si elle est très en retard (décodeur lent) :
        // à 50 ms, on supprimait des frames utiles sur les fichiers légers.
        late = this.videoFrameBuffer[0].timestamp < (this.currentVideoTime() * 1000) - 500000;
      } catch {}
      const f = late ? this.videoFrameBuffer.shift() : this.videoFrameBuffer.pop();
      try { f.close(); } catch {}
      this._lateDropped = (this._lateDropped ?? 0) + 1;
    }
    this.schedulePipelinePump();
    this.schedulePresent();
  }

  /** Présente sans dépendre uniquement de la rAF du worker (throttlée en
   * arrière-plan / parfois arrêtée) : une macrotâche coalescée, jamais dans le
   * callback du décodeur (Firefox n'aime pas y transférer les frames). */
  schedulePresent() {
    if (this._presentScheduled || !this.isPlaying || this.isSeeking) return;
    this._presentScheduled = true;
    setTimeout(() => {
      this._presentScheduled = false;
      if (!this.isPlaying || this.isSeeking) return;
      try { this.renderVideo(); } catch {}
    }, 0);
  }

  renderVideoLoop() {
    if (!this.isPlaying || this.isSeeking) return;
    // Chien de garde : décodeur muet avec du travail en attente (file paquets
    // non vide, rien ne sort depuis 10s alors que ça a déjà démarré) → reset
    // + reconfigure + vide les files (périmées de toute façon). Sans ça, un
    // décodeur coincé fige l'image pour toujours (vu en beta).
    try {
      const stalled = (this._vOut ?? 0) > 0 &&
        performance.now() - (this._lastVOutT ?? 0) > 10000 &&
        (this.videoPacketQueue.length > 0 || (this.videoFrameBuffer?.length ?? 0) > 0);
      if (stalled) {
        console.warn("[decode] stall vidéo 10s DÉTECTÉ (reset désactivé en diagnostic)");
        this._lastVOutT = performance.now(); // répit 10s avant prochain signalement
        this.schedulePipelinePump();
      }
    } catch {}
    const now = performance.now();
    // Alerte unique : si une grande part des frames n'atteint jamais l'écran
    // (source trop lourde pour ce navigateur/matériel), le dire clairement.
    if (!this._slowWarned && this.isPlaying && (this._vOut ?? 0) > 120 &&
        now - (this._slowCheckAt ?? 0) > 5000) {
      const dropped = (this._lateDropped ?? 0) + (this._staleDropped ?? 0);
      const ratio = dropped / Math.max(1, this._vOut);
      if (ratio > 0.4) {
        this._slowWarned = true;
        console.warn(
          `[video] ${Math.round(ratio * 100)} % des frames ne sont pas affichées` +
            " (décodage/rendu trop lent pour cette source) — le son reste prioritaire ;" +
            " si possible activez le décodage matériel ou une version plus légère",
        );
      }
      this._slowCheckAt = now;
    }
    const lm = this.lagMonitor;

    let frameTime = 0;
    if (lm.lastFrameTime > 0) {
      frameTime = now - lm.lastFrameTime;
      lm.frameTimes.push(frameTime);
      if (frameTime > lm.lagThresholdMs) {
        lm.totalLagEvents++;
      }
    }
    lm.lastFrameTime = now;

    if (now - lm.lastReportTime >= lm.reportInterval) {
      if (lm.frameTimes.length > 0) {
        const avg = lm.frameTimes.reduce((a, b) => a + b, 0) / lm.frameTimes.length;
        const fps = 1000 / avg;
        self.postMessage({
          type: "workerLagReport",
          fps: Math.round(fps),
          avgFrameTime: Math.round(avg * 10) / 10,
          totalLagEvents: lm.totalLagEvents,
          lastFrameTime: Math.round(frameTime),
        });
      }
      lm.frameTimes = [];
      lm.lastReportTime = now;
    }

    this.renderVideo();
    this.schedulePipelinePump();
    this.scheduleRenderLoop();
  }

  renderVideo() {
    if (this.videoFrameBuffer.length == 0) return;
    const currentTime = this.currentVideoTime() * 1000;
    // Tolérance de péremption en MICROSECONDES (frame.timestamp est en µs,
    // currentTime aussi : currentVideoTime() est en ms × 1000). L'ancienne
    // valeur 16.67 valait 16,67 µs, pas 16,67 ms : quasi toutes les frames
    // étaient « périmées » et jetées (flashs courts invisibles, ~50 % de drops).
    const VSYNC_INTERVAL = 50 * 1000;
    while (
      this.videoFrameBuffer.length > 1 &&
      this.videoFrameBuffer[0].timestamp < currentTime - VSYNC_INTERVAL
    ) {
      let staleFrame = this.videoFrameBuffer.shift();
      try { staleFrame.close(); } catch {}
      this._staleDropped = (this._staleDropped ?? 0) + 1;
    }

    // Envoi au render worker (transfert zéro-copie) UNIQUEMENT si la tête a
    // changé : le render ré-affiche son image en boucle via sa propre rAF
    // (nécessaire en WebGL sans preserveDrawingBuffer). Même pixels qu'avant.
    // Note : après transfert le handle local est neutralisé — lecture de
    // .timestamp protégée (illisible = déjà affichée = on ne re-poste pas).
    const head = this.videoFrameBuffer[0];
    if (!head || !this.renderPort) return;
    let pts = null;
    try { pts = head.timestamp; } catch { return; }
    if (pts === this._lastSentPts) return;
    // Présentation à l'heure : ne PAS envoyer une frame en avance. Le décodeur
    // sort jusqu'à ~1 s d'avance (queue + burst) ; la poster tout de suite
    // faisait jouer la vidéo en avance sur le son (flashs visibles ~1 s trop
    // tôt, dérive A/V non détectée par l'horloge interne).
    if (pts > currentTime + 2000) return; // µs (lead 2 ms)
    // Backpressure : une frame 4K = 13,5 Mio. Sans plafond, si le renderer
    // dessine moins vite qu'on ne poste, le MessagePort accumule tout
    // (+750 Mio/s observés jusqu'au crash) : on garde ≤2 frames en vol.
    if ((this._framesInFlight ?? 0) > 2) return;
    this._lastSentPts = pts;
    try {
      // Payload sans fonctions : les wrappers SW portent close() (non
      // clonable via postMessage — DataCloneError avalé = image noire pour
      // TOUT décodage logiciel). On n'envoie que ce que le renderer utilise.
      const source = head.source || head.bitmap || head;
      const payload = {
        type: "frame",
        frame: {
          source,
          timestamp: head.timestamp,
          displayWidth: head.displayWidth,
          displayHeight: head.displayHeight,
        },
      };
      const xfer = [];
      if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) xfer.push(source);
      else if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) xfer.push(source);
      this.renderPort.postMessage(payload, xfer);
      this._posted = (this._posted ?? 0) + 1;
      this._framesInFlight = (this._framesInFlight ?? 0) + 1;
      // La tête est partie (transférée) : on l'avance tout de suite pour que
      // la suivante devienne tête et soit présentée à SON heure.
      this.videoFrameBuffer.shift();
    } catch {
      this._lastSentPts = null;
    }
  }

  /** Signale au render worker d'oublier son image (seek/track-change). */
  postRenderClear() {
    this._lastSentPts = null; // la prochaine tête (même pts) doit repartir
    this._framesInFlight = 0; // les acks en retard ne doivent pas bloquer
    this._playStartedAt = performance.now(); // grâce après seek (drift)
    try { this.renderPort?.postMessage({ type: "clear" }); } catch {}
  }

  async feedAudioDecoder() {
    // Audio step 2/3: send the demuxed audio packets to the audio decoder
    if (this.isSeeking && !this._priming) {
      this._warnSeekFeed("audio");
      return;
    }
    if (this.audioFillInProgress) return;
    this.audioFillInProgress = true;
    try {
      await this.feedAudioDecoderInternal();
    } finally {
      this.audioFillInProgress = false;
    }
  }

  async feedAudioDecoderInternal() {
    // Audio step 2/3: send the demuxed audio packets to the audio decoder
    // Based on https://github.com/w3c/webcodecs/blob/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/lib/audio_renderer.js#L83
    const ep = this.seekSerial; // fencing d'époque (cf. pumpPipeline)
    if (this.audioStreamIndex === -1 || !this.ringbuffer) return;
    if (this.audioUseWebCodecs && !this.WCAudioDecoder) return;
    if (!this.audioUseWebCodecs && !this.AudioDecoderCodecContext) return;
    if (
      this.audioUseWebCodecs &&
      this.WCAudioDecoder.decodeQueueSize >= this.DECODER_QUEUE_SIZE_MAX
    ) {
      // Decoder is saturated, wait for it to drain
      return;
    }
    let usedBufferElements =
      this.ringbuffer.capacity() - this.ringbuffer.available_write();
    let usedBufferSecs =
      usedBufferElements / (this.channelCount * this.audioSampleRate);
    if (usedBufferSecs >= this.DATA_BUFFER_DECODE_TARGET_DURATION) {
      // Buffer is sufficiently full, wait before decoding more
      if (this.isPlaying) {
        this.feedAudioDecoderTimeout = setTimeout(
          this.feedAudioDecoder.bind(this),
          (1000 * usedBufferSecs) / 2,
        );
      }
      return;
    }

    try {
      while (
        usedBufferSecs < this.DATA_BUFFER_DECODE_TARGET_DURATION &&
        (!this.audioUseWebCodecs ||
          (this.WCAudioDecoder &&
            this.WCAudioDecoder.decodeQueueSize < this.DECODER_QUEUE_SIZE_MAX))
      ) {
        if (this.audioPacketQueue.length === 0) {
          const tR = performance.now();
          await this.refillFrameQueues("audio");
          this._aRefillMs = performance.now() - tR;
          if (ep !== this.seekSerial) return; // seek entre-temps : paquets périmés
          if (this.audioPacketQueue.length === 0) {
            // Fin de piste ou famine : ne pas inonder la console (le pompage
            // rappelle cette fonction en boucle).
            const now = performance.now();
            this._audioEmptyCount = (this._audioEmptyCount ?? 0) + 1;
            if (now - (this._audioEmptyWarnAt ?? 0) > 2000) {
              console.warn(
                `No more audio packets available (${this._audioEmptyCount} fois)`,
              );
              this._audioEmptyWarnAt = now;
              this._audioEmptyCount = 0;
            }
            break;
          }
        }
        let packet = this.dequeuePacket("audio");
        if (packet == undefined) {
          break;
        }
        if (this.audioUseWebCodecs && this.WCAudioDecoder) {
          const chunk = LibAVJSWebCodecs.packetToEncodedAudioChunk(
            packet,
            this.streams[this.audioStreamIndex],
          );
          if (!this.WCAudioDecoder) return;
          this._aFed = (this._aFed ?? 0) + 1;
          if (this.WCAudioDecoder.state !== "configured") break;
          this.WCAudioDecoder.decode(new EncodedAudioChunk(chunk));
        } else {
          if (!this.AudioDecoderCodecContext) return;
          var frames = await this.libav.ff_decode_multi(
            this.AudioDecoderCodecContext,
            this.AudioDecoderPacket,
            this.AudioDecoderFrame,
            [packet],
            false,
          );
          if (!frames || frames.length === 0) {
            if ((this._audioDecodeWarn || 0) < 5) {
              console.warn(
                `[audio] ff_decode_multi returned ${frames?.length} frames, pts=${packet.pts} dts=${packet.dts} size=${packet.size}`,
              );
              this._audioDecodeWarn = (this._audioDecodeWarn || 0) + 1;
            }
          }
          if (frames) {
            for (const frame of frames) {
              this.bufferAudioSamples(frame);
            }
          }
        }
        usedBufferElements =
          this.ringbuffer.capacity() - this.ringbuffer.available_write();
        usedBufferSecs =
          usedBufferElements / (this.channelCount * this.audioSampleRate);
      }
    } catch (e) {
      console.error("Error decoding audio data:", e);
    }
  }

  convertSampleToFloat32Array(data) {
    let samples;
    switch (data.constructor.name) {
      case "Uint8Array":
        samples = Float32Array.from(data, (x) => (x - 128) / 128);
        break;
      case "Uint16Array":
        samples = Float32Array.from(data, (x) => (x - 32768) / 32768);
        break;
      case "Uint32Array":
        samples = Float32Array.from(data, (x) => (x - 2147483648) / 2147483648);
        break;
      case "Int8Array":
        samples = Float32Array.from(data, (x) => x / 128);
        break;
      case "Int16Array":
        samples = Float32Array.from(data, (x) => x / 32768);
        break;
      case "Int32Array":
        samples = Float32Array.from(data, (x) => x / 2147483648);
        break;
      case "Float32Array":
        samples = data;
        break;
      default:
        throw `Unsupported audio sample format: ${data.constructor.name}`;
    }
    return samples;
  }

  bufferAudioSamples(data) {
    // Audio step 3/3: buffer decoded audio data into the ring buffer
    // this gets called from the audio decoder output callback (when a frame is decoded)
    // the ring buffer is then read by the AudioWorkletProcessor
    this._aOut = (this._aOut ?? 0) + 1;

    // based on https://github.com/w3c/webcodecs/blob/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/lib/audio_renderer.js#L168
    if (this.isSeeking && !this._priming)
      console.warn(
        "bufferAudioSamples called while seeking (output of audio decoder)",
      );
    const isAudioData = data instanceof AudioData;
    const frameNumber = isAudioData ? data.numberOfFrames : data.nb_samples;
    if (!isAudioData && (this._audioDebugCount || 0) < 3) {
      const planar = data.data instanceof Array;
      const el = planar ? data.data[0] : data.data;
      const formatName = planar ? "planar" : "interleaved";
      const typeName = el?.constructor?.name ?? "unknown";
      const chLayout = data.ch_layout_nb_channels ?? "?";
      const fmtNames = {3:"FLT",8:"FLTP",1:"S16",7:"S32P"};
      const fmtName = fmtNames[data.format] ?? `fmt=${data.format}`;
      console.log(
        `[audio] libav frame: nb_samples=${data.nb_samples}`,
        `sr=${data.sample_rate} ch=${data.channels} ch_layout=${chLayout}`,
        `${formatName} ${typeName} ${fmtName}`,
      );
      this._audioDebugCount = (this._audioDebugCount || 0) + 1;
    }
    if (this.audioPrerollTargetSeconds !== null) {
      const frameTime = this.frameTimeSeconds(data);
      const frameEnd = frameTime == null
        ? null
        : frameTime + this.frameDurationSeconds(data);
      if (frameEnd !== null && frameEnd < this.audioPrerollTargetSeconds) {
        if (isAudioData) data.close();
        this.schedulePipelinePump();
        return;
      }
      this.audioPrerollTargetSeconds = null;
    }
    if (!this._planarBuffers || this._planarBuffers.length !== this.channelCount ||
        (this._planarFrameNumber || 0) < frameNumber) {
      this._planarBuffers = new Array(this.channelCount);
      this._planarFrameNumber = frameNumber;
      for (var i = 0; i < this.channelCount; i++) {
        this._planarBuffers[i] = new Float32Array(frameNumber);
      }
    }
    const planarBuffers = this._planarBuffers;
    let samples;
    if (!isAudioData) {
      if (data.data instanceof Array) {
        // LibAV frame with planar data
        samples = Array(this.channelCount);
        for (let i = 0; i < data.data.length; i++) {
          samples[i] = this.convertSampleToFloat32Array(data.data[i]);
        }
      } else {
        // LibAV frame with interleaved data
        samples = this.convertSampleToFloat32Array(data.data);
      }
    }

    // Write to temporary planar arrays, and interleave into the ring buffer.
    for (var i = 0; i < this.channelCount; i++) {
      if (i >= (isAudioData ? data.numberOfChannels : data.channels)) break;
      if (isAudioData) {
        data.copyTo(planarBuffers[i], {
          planeIndex: i,
          format: "f32-planar",
        });
      } else {
        // LibAV frame
        if (samples instanceof Array) {
          // planar data
          planarBuffers[i].set(samples[i].subarray(0, frameNumber));
        } else {
          // interleaved data (sample-interleaved: ch0_s0, ch1_s0, ..., ch0_s1, ch1_s1, ...)
          for (let j = 0; j < frameNumber; j++) {
            planarBuffers[i][j] = samples[j * this.channelCount + i];
          }
        }
      }
    }
    // Write the data to the ring buffer. Because it wraps around, there is
    // potentially two copyTo to do.
    let wrote = this.ringbuffer.writeCallback(
      frameNumber * this.channelCount,
      (first_part, second_part) => {
        this.interleave(planarBuffers, 0, first_part.length, first_part, 0);
        this.interleave(
          planarBuffers,
          first_part.length,
          second_part.length,
          second_part,
          0,
        );
      },
    );

    // FIXME - this could theoretically happen since we're pretty agressive
    // about saturating the decoder without knowing the size of the
    // AudioData.duration vs ring buffer capacity.
    console.assert(
      wrote == this.channelCount * frameNumber,
      "Buffer full, dropping data!",
    );
    if (isAudioData) data.close();

    // Logging maxBufferHealth below shows we currently max around 73%, so we're
    // safe from the assert above *for now*. We should add an overflow buffer
    // just to be safe.
    this._aFillAt = performance.now();
    this._aFills = (this._aFills ?? 0) + 1;
    // let bufferHealth = this.bufferHealth();
    // if (!('maxBufferHealth' in this))
    //   this.maxBufferHealth = 0;
    // if (bufferHealth > this.maxBufferHealth) {
    //   this.maxBufferHealth = bufferHealth;
    //   console.log(`new maxBufferHealth:${this.maxBufferHealth}`);
    // }
    //
    this.schedulePipelinePump();
  }

  interleave(
    inputs,
    inputOffset,
    inputSamplesToCopy,
    output,
    outputSampleOffset,
  ) {
    // Based on https://github.com/w3c/webcodecs/blob/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/lib/audio_renderer.js#L151
    if (inputs.length * inputs[0].length < output.length) {
      throw `not enough space in destination (${inputs.length * inputs[0].length} < ${output.length}})`;
    }
    let channelCount = inputs.length;
    let outIdx = outputSampleOffset;
    let inputIdx = Math.floor(inputOffset / channelCount);
    var channel = inputOffset % channelCount;
    for (var i = 0; i < inputSamplesToCopy; i++) {
      output[outIdx++] = inputs[channel][inputIdx];
      if (++channel == inputs.length) {
        channel = 0;
        inputIdx++;
      }
    }
  }
}

// Create and initialize the worker when the script loads
new MediaWorker();
