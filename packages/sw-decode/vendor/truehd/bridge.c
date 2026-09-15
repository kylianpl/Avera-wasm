// packages/sw-decode/vendor/truehd/bridge.c — pont minimal decode-only TrueHD.
// Compilé avec libavcodec + libavutil FFmpeg (LGPL-2.1-or-later, voir
// BUILD.md). API pensée pour cwrap : uniquement int/pointeurs, aucune
// struct exposée.
//
// Protocole :
//   slot = truehd_create(86060)   // 86060=truehd → 0..3, <0 si échec
//   n = truehd_decode(slot, in, len, out, cap, &sr, &ch, &nb)
//       // Envoie UN paquet (une ou plusieurs units TrueHD contiguës).
//       // Écrit l'entrelacé float32 : n échantillons/voie, sr/ch/nb renseignés.
//       // Retourne n (≥0) ; <0 si erreur (voir codes ci-dessous).
//   truehd_flush(slot)                  // reset post-seek (avcodec_flush_buffers)
//   truehd_free(slot)
//
// Notes :
// - Le décodeur TrueHD natif FFmpeg sort du float planaire (FLTP) ;
//   on entrelace ici pour coller au chemin audio existant (Float32Array
//   entrelacé, cf. bufferAudioSamples dans app/worker.js).
// - Le décodeur est sans état inter-units : décoder les paquets en continu
//   donne un PCM exact ; le flush post-seek est une sécurité standard.
#include <stdint.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavutil/dict.h>
#include <libavutil/frame.h>
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>

#define MAX_SLOTS 4

static AVCodecContext *G_ctx[MAX_SLOTS] = {0, 0, 0, 0};
static AVPacket *G_pkt[MAX_SLOTS] = {0, 0, 0, 0};
static AVFrame *G_frm[MAX_SLOTS] = {0, 0, 0, 0};

static void slot_clear(int slot) {
  if (G_frm[slot]) { av_frame_free(&G_frm[slot]); }
  if (G_pkt[slot]) { av_packet_free(&G_pkt[slot]); }
  if (G_ctx[slot]) { avcodec_free_context(&G_ctx[slot]); }
}

int truehd_create(int codec_id) {
  if (codec_id != 86060) return -1;
  const AVCodec *dec = avcodec_find_decoder_by_name("truehd");
  if (!dec) return -1;
  int slot = -1;
  for (int i = 0; i < MAX_SLOTS; i++) {
    if (!G_ctx[i]) { slot = i; break; }
  }
  if (slot < 0) return -2;
  AVCodecContext *ctx = avcodec_alloc_context3(dec);
  if (!ctx) return -3;
  ctx->request_sample_fmt = AV_SAMPLE_FMT_FLTP;
  // (pas d'option ici : le décodeur TrueHD est déterministe tel quel ;
  // la comparaison native est assertée en test, cf. BUILD.md).
  const int oret = avcodec_open2(ctx, dec, NULL);
  if (oret < 0) {
    avcodec_free_context(&ctx);
    return -4;
  }
  G_pkt[slot] = av_packet_alloc();
  G_frm[slot] = av_frame_alloc();
  if (!G_pkt[slot] || !G_frm[slot]) {
    slot_clear(slot);
    return -5;
  }
  G_ctx[slot] = ctx;
  return slot;
}

int truehd_decode(int slot, const uint8_t *in, int in_len, float *out, int cap,
                int *o_sr, int *o_ch, int *o_nb) {
  if (slot < 0 || slot >= MAX_SLOTS || !G_ctx[slot]) return -1;
  if (!in || in_len <= 0 || !out || cap <= 0) return -2;
  AVCodecContext *ctx = G_ctx[slot];
  AVPacket *pkt = G_pkt[slot];
  AVFrame *frm = G_frm[slot];
  pkt->data = (uint8_t *)in;
  pkt->size = in_len;
  int ret = avcodec_send_packet(ctx, pkt);
  av_packet_unref(pkt); // send a copié/référencé ce qu'il lui faut
  if (ret < 0) return -3;
  int total = 0;
  int ch0 = -1;
  for (;;) {
    ret = avcodec_receive_frame(ctx, frm);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
    if (ret < 0) return -4;
    // TrueHD/MLP : FLTP, S32P ou S32 packé selon le contenu.
    const int is_f32 = frm->format == AV_SAMPLE_FMT_FLTP;
    const int is_s32p = frm->format == AV_SAMPLE_FMT_S32P;
    const int is_s32 = frm->format == AV_SAMPLE_FMT_S32;
    if (!is_f32 && !is_s32p && !is_s32) {
      av_frame_unref(frm);
      return -5;
    }
    const int nb = frm->nb_samples;
    const int ch = frm->ch_layout.nb_channels;
    if (ch0 < 0) ch0 = ch;
    if (ch != ch0 || total + nb > cap) {
      av_frame_unref(frm);
      return -6; // changement de layout mid-paquet ou tampon JS trop petit
    }
    if (is_s32) {
      // Packé : recopie directe avec mise à l'échelle.
      const int32_t *packed = (const int32_t *)frm->data[0];
      for (int i = 0; i < nb * ch; i++) out[total * ch + i] = (float)packed[i] / 2147483648.0f;
    } else for (int c = 0; c < ch; c++) {
      if (is_f32) {
        const float *plane = (const float *)frm->extended_data[c];
        for (int i = 0; i < nb; i++) out[(total + i) * ch + c] = plane[i];
      } else {
        const int32_t *plane = (const int32_t *)frm->extended_data[c];
        for (int i = 0; i < nb; i++) out[(total + i) * ch + c] = (float)plane[i] / 2147483648.0f;
      }
    }
    total += nb;
    if (o_sr) *o_sr = frm->sample_rate;
    if (o_ch) *o_ch = ch;
    av_frame_unref(frm);
  }
  if (o_nb) *o_nb = total;
  return total;
}

void truehd_flush(int slot) {
  if (slot < 0 || slot >= MAX_SLOTS || !G_ctx[slot]) return;
  avcodec_flush_buffers(G_ctx[slot]);
}

void truehd_free(int slot) {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  slot_clear(slot);
}
