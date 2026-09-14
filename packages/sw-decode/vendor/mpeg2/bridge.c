// packages/sw-decode/vendor/mpeg2/bridge.c — pont minimal decode-only MPEG-2.
// Compilé avec libavcodec + libavutil FFmpeg (LGPL-2.1-or-later, voir
// BUILD.md). API pensée pour cwrap : slots int, buffers pré-alloués côté JS.
//
// Protocole :
//   slot = mpeg2_create("mpeg2video"|"mpeg1video", w, h)
//       → 0..3, <0 si échec (w/h informatifs : la séquence les impose).
//   r = mpeg2_decode(slot, in, len, out, cap, expW, expH, &o_w, &o_h)
//       // Décode UN paquet (in==NULL ou len<=0 : drainage de fin).
//       // Écrit de l'I420 dense (Y + U + V contigus, strides = largeurs).
//       // Retourne 1 (frame écrite) / 0 (rien : délai ou drainage vide) / <0.
//
// Conversion : YUV planaire 8 bits (420/422 → 420 par moyennes, 400 →
// gris+128), plage recopiée telle quelle (comme libde265). Entrelacé :
// les champs sont recopiés tels quels (pas de désentrelacement v1 —
// peigne possible sur sources DVD entrelacées ; fixtures progressives).
//   mpeg2_flush(slot)   // reset post-seek (avcodec_flush_buffers)
//   mpeg2_free(slot)
//
// Conversion : les décodeurs sortent du YUV planaire 8 bits (420/422/444,
// full-range ou non, éventuellement 1 seul plan) ; on rééchantillonne ici
// en 4:2:0 (moyennes), la plage est recopiée telle quelle (comme libde265).
#include <stdint.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/pixfmt.h>

#define MAX_SLOTS 4

static AVCodecContext *G_ctx[MAX_SLOTS] = {0, 0, 0, 0};
static AVPacket *G_pkt[MAX_SLOTS] = {0, 0, 0, 0};
static AVFrame *G_frm[MAX_SLOTS] = {0, 0, 0, 0};

static void slot_clear(int slot) {
  if (G_frm[slot]) { av_frame_free(&G_frm[slot]); }
  if (G_pkt[slot]) { av_packet_free(&G_pkt[slot]); }
  if (G_ctx[slot]) { avcodec_free_context(&G_ctx[slot]); }
}

int mpeg2_create(const char *name, int w, int h) {
  if (!name) return -1;
  char safe[16];
  int i = 0;
  for (; i < 15 && name[i]; i++) {
    char c = name[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return -1;
    safe[i] = c;
  }
  safe[i] = '\0';
  const AVCodec *dec = avcodec_find_decoder_by_name(safe);
  if (!dec) return -1;
  int slot = -1;
  for (int k = 0; k < MAX_SLOTS; k++) {
    if (!G_ctx[k]) { slot = k; break; }
  }
  if (slot < 0) return -2;
  AVCodecContext *ctx = avcodec_alloc_context3(dec);
  if (!ctx) return -3;
  // MPEG-1/2 portent leurs dimensions (séquence) : w/h informatifs.
  (void)w; (void)h;
  if (avcodec_open2(ctx, dec, NULL) < 0) {
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

// Copie un plan avec sous-échantillonnage (sx, sy) vers une cible dense.
static void copy_plane(uint8_t *dst, int dst_stride, const uint8_t *src,
                       int src_stride, int w, int h, int sx, int sy) {
  for (int y = 0; y < h; y++) {
    const uint8_t *row = src + (y * sy) * src_stride;
    uint8_t *d = dst + y * dst_stride;
    if (sx == 1 && sy == 1) {
      memcpy(d, row, w);
    } else {
      for (int x = 0; x < w; x++) {
        int sum = 0;
        for (int ay = 0; ay < sy; ay++) {
          for (int ax = 0; ax < sx; ax++) {
            sum += row[ay * src_stride + x * sx + ax];
          }
        }
        d[x] = (uint8_t)((sum + (sx * sy) / 2) / (sx * sy));
      }
    }
  }
}

int mpeg2_decode(int slot, const uint8_t *in, int in_len, uint8_t *out, int cap,
                int exp_w, int exp_h, int *o_w, int *o_h) {
  if (slot < 0 || slot >= MAX_SLOTS || !G_ctx[slot]) return -1;
  if (!out || cap <= 0) return -2;
  AVCodecContext *ctx = G_ctx[slot];
  AVPacket *pkt = G_pkt[slot];
  AVFrame *frm = G_frm[slot];
  int ret;
  if (!in || in_len <= 0) {
    ret = avcodec_send_packet(ctx, NULL); // drainage
    if (ret < 0) return 0;
  } else {
    pkt->data = (uint8_t *)in;
    pkt->size = in_len;
    ret = avcodec_send_packet(ctx, pkt);
    av_packet_unref(pkt);
    if (ret < 0) return -3;
  }
  ret = avcodec_receive_frame(ctx, frm);
  if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
  if (ret < 0) return -4;
  const int w = frm->width, h = frm->height;
  if (o_w) *o_w = w;
  if (o_h) *o_h = h;
  if (w != exp_w || h != exp_h || w <= 0 || h <= 0) {
    av_frame_unref(frm);
    return -6; // résolution inattendue (changements non supportés)
  }
  const int uv_w = (w + 1) >> 1, uv_h = (h + 1) >> 1;
  const int y_size = w * h, uv_size = uv_w * uv_h;
  if (y_size + 2 * uv_size > cap) {
    av_frame_unref(frm);
    return -6;
  }
  // (sx, sy) = échantillons source par échantillon cible. Les plans du
  // décodeur sont déjà à leur résolution native : 420 = copie directe,
  // 422 = moyenne verticale, 444 = moyenne 2×2.
  int sx = 1, sy = 1, planes = 3;
  switch (frm->format) {
    case AV_PIX_FMT_YUV420P:
    case AV_PIX_FMT_YUVJ420P:
      sx = 1; sy = 1; break;
    case AV_PIX_FMT_YUV422P:
    case AV_PIX_FMT_YUVJ422P:
      sx = 1; sy = 2; break;
    case AV_PIX_FMT_YUV444P:
    case AV_PIX_FMT_YUVJ444P:
      sx = 2; sy = 2; break;
    case AV_PIX_FMT_GRAY8:
      planes = 1; break;
    default:
      av_frame_unref(frm);
      return -5; // format de sortie inattendu
  }
  copy_plane(out, w, frm->data[0], frm->linesize[0], w, h, 1, 1);
  if (planes == 3) {
    copy_plane(out + y_size, uv_w, frm->data[1], frm->linesize[1], uv_w, uv_h, sx, sy);
    copy_plane(out + y_size + uv_size, uv_w, frm->data[2], frm->linesize[2], uv_w, uv_h, sx, sy);
  } else {
    memset(out + y_size, 128, 2 * uv_size);
  }
  av_frame_unref(frm);
  return 1;
}

void mpeg2_flush(int slot) {
  if (slot < 0 || slot >= MAX_SLOTS || !G_ctx[slot]) return;
  avcodec_flush_buffers(G_ctx[slot]);
}

void mpeg2_free(int slot) {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  slot_clear(slot);
}
