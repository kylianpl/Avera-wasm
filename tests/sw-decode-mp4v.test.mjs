// tests/sw-decode-mp4v.test.mjs — décodeur logiciel MPEG-4 ASP et cousins.
// Bridge FFmpeg decode-only (vendor/mp4v) : mpeg4 (XVID/DIVX), h263,
// mjpeg (420/422/444 → I420). Référence native bit-exacte (MD5) pour les
// chemins 420, moyennes + déterminisme pour 422/444 (rééchantillonnage C).
// Note : le natif duplique la frame en position 2 sur les fixtures avec
// chunk vide (76 frames pour 75 paquets) — mapping pris en compte, et notre
// sortie (75 frames propres) est la référence saine.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createMP4VSession } from "../packages/sw-decode/src/mp4v.js";
import {
  CompatLib, ff_init_demuxer_file, ff_read_frame_multi,
  ff_init_decoder, ff_decode_multi, ff_free_decoder, avcodec_flush_buffers,
  AVMEDIA_TYPE_VIDEO, AVERROR_EOF,
} from "../packages/demux-compat/src/compat.js";

const FIX = (n) => new URL(`./fixtures/${n}`, import.meta.url);
const md5 = (b) => createHash("md5").update(b).digest("hex");

// MD5 natifs (ffmpeg 8.1.2 -- non, 9.0.1 -threads 1 -f rawvideo) par frame.
// Les 3s ont un doublon natif en position 2 (chunk vide ffmpeg) : mapping i<2→i, i≥2→i+1.
const REF_XVID = [
  "0fac011b450ebd5e3306269b9de77ae3", "8b9b7da28ab3839c296b607b9b0ee8ad", "8b9b7da28ab3839c296b607b9b0ee8ad", "8bdd76104f8e6d2a4029eaa69f1f8eca",
  "bf6540728fec1d6059f91b97dae64d20", "2f2fdd1eb5d666ef9c648042b4950451", "5bb47fc8bb7548638d9e005f9cc3032d", "fdf5bfc3e6beeb1a149a61ef0ee7f0f0",
  "8fb15f7945307e865608e938228a7a77", "576bd7785972e7b9652dae5c531b2395", "4687bdfb2e79483235dca207cb8d4b76", "ce6f0244d900ffdb48599f635be5f207",
  "c8255b87c17d9899c011cfb4122e25a7", "5dc2a92cea7df631d12561efc2402c0b", "e66d1b5464e5d8e8cf59aecb84524c8b", "0f33c48149bc90b2239cd6a613cc531f",
  "ad93bee859c1ee3d8239bdd20caf5c17", "a53fde5f477b9ef45ba6c36b2db6ad67", "549570161cc489c4f1e2c48cc3a9c416", "792d6b309cc2a42ba6391013e2a3e652",
  "90cc44de4f0acb6a0b219355c415dbae", "88907cee1de2155f647b35ddcbc2aec5", "164436b47db7ccd1b50388edec26fcbf", "9687af13c6ed48512a9dd775a9f5eb9e",
  "e597221874649cdcf2e635e1d87cfa90", "7d425a0f4bbebbb5e1aef71885390080", "f762a56e0c37317174c61a3178921799", "8795afb8089afa064499844b486cc2f2",
  "75377538566e56edeef8151767fbe873", "d7f9355ef3de3da63f4287eb0c6da81f", "fa45786d9acb2cbe769c14ea7df18995", "b5320c84a52ab2da7100475ba5b37edf",
  "5638dca71695b7411c8a8f90d0840982", "f86c135a0d7276ba00215dbb965acbf9", "d2c13bc35937297e91c30a5cb69f6cba", "9a9ca5b30e280b4d9f9d053a931e601e",
  "a4b8fe88c22943ce6ac1adbd833326d9", "c66a6e569388de104b147812de8a3384", "e563710969f9bbd817c766df788465e2", "1cd670ddca5df177c612420ae62568f9",
  "49700e26071a1b4e460495b5b8d3112e", "6a1f5524bd64f7a0bfa13e83d21c734f", "d97a79637a74901f17b4a55065b1e726", "bc8734149e20e49a3e5530cdd10f36d5",
  "f4c36a3d7b2ed8ead0143ff8d2a8be1a", "afe2f9807346337d4b5f06641f7f1ced", "fe739dafbfec8e3d86596b7f7531503e", "9247a69a5f6b93c621ba7d9c1137e00c",
  "e8b336fa2840a1f68e780fe6195df94b", "340477ea4a24b27617a18135dc672f72", "3093c3209aa3db6a2cd5b6caa9a84151", "d1d71974906aa17ce24abad5a1b56fa2",
  "3001366f17ae6e627af2b54c8599d7a0", "7427a4305025aa78407917d7cfbec514", "564653c13704606e23533d4feb47ca5c", "6d391b3ee40a90ac8e8bccbc355d41dc",
  "ac527a5084dae88de1bd70a0938e05df", "96f2438ac5b95d88a1627742e32c0e46", "4325ed410813d1febdd2844f5d375d82", "380d30fbaabddebbded35eecfc2c09fe",
  "39997ea479e37b077f2a4e58a14d2a5e", "5627a8664b720f3bc004e6bd96ea3603", "2a57745f709741bb384e5e02ad13247a", "1f5d92d33b5f8f13849a8146bebe9885",
  "0437c5c40d60689048db4d865da5210d", "d7c2873b18eaf62b8f3d6b9fb676906a", "043c813ec28f16427df9ec1f91d89646", "87963d96e211c4b9b61f1a4ae8df9e5d",
  "d9386eedcd00ec8ff2581005e874380e", "d637076116799a622b316010747672fb", "5ccea9afac664d824f370d908f8c7c91", "2ccf5bdc5f490d80821b79825755d14d",
  "932571b58345d8ab26cce6df623aaf19", "75bda9b8c61ac85d32bbbed2e87868f0", "cf88e96eb0743b85ec6124adbd19b279", "1030cd90a370c5a37dd9fe258f6278d1",
];
const REF_H263 = [
  "b4453293205adfe0e7396b720a4941a8", "aaedbec56a59c9a593f5ec659073e8bf", "aaedbec56a59c9a593f5ec659073e8bf", "5ab2327d23b059732d00972d5b2a9139",
  "04c3619e7728598e162ecd761d4fafc8", "0516dd9ca6cc23faa816218015e06980", "0a3555eda30835097aa05fec0e08a508", "d33c3bb967b14075f4379174f0bd8b21",
  "5a621699d2b759eaad71756fb0af9f98", "7ba5cff23787a7b5e23145b1691bce6f", "29a953b5f7311191fc6f8cef6caade8f", "95b6337bf7405b693612532cf18228ac",
  "4dc0c00322b9539b98b70850dcac3707", "b35f43f022a16af01ba741589e996bf8", "7e7064c200ccd62f773e5673aa4d5297", "e4a5fc7d8809fc3a5216fc4d28718430",
  "727f459d54d67e90921a1a4bb0ab3159", "fedf736c534923c257f992b2050b69a3", "38cb209d87c129ac2e618f28f31948c4", "58496de72bfbbc12aea62f71c8dbb049",
  "0b5f215a175a62a9682ab446be4a6aa1", "ea64c9656818e9fa32629eb04c27f128", "408df77dc8b7fb694e6d7fb3011d2280", "173a88b4a1697be43813ca28d00e032c",
  "115211b3ab55029cb0e38858ee3a198c", "b889594d41ddd5f9e20641e0ceb1fe54", "a22c2c4d787e697d10c3272601b424a7", "9f8a321c8e29b25e15be60a9750af5c6",
  "f30a470c86fb46dd4c029996f8b6f235", "0958fb31a8cffe7b23b38bee442d1b37", "d2b787dce44c0e212ec490ee0c690a9f", "19f037cf554feac22085730b95a5240b",
  "7489dea2b6e75d658c14330f84f216ea", "925bb31390d4b9fc4562b75958b32f8c", "ca88ab2596457165eb957889b827c0e5", "2a4a4248e49f768a03d1faee950ec620",
  "98ee0b83676bcb7e629ee5d854d32dab", "a590f7955aa04eee288129702d915753", "231fff7a4c5a76ea44f411ed222c431e", "06bc3d44d32e7ec319a554bc859495e3",
  "54353dc78e3ce4d176370b25a998e8e2", "bd00e31663e14738856bb2ae7943f336", "be7dec07771fb66f474f78fb8b6cdd4c", "bd973b2cc4db8b36f67ad220e0c182e7",
  "cffce46e3e282ab97282ec386c6e4da0", "30281b01a6b1a4256bbc4a601efd343e", "96ce6f844311f044837da4c4275260ef", "a156870c40edeb35b09d7966e7c3d2cc",
  "b2d687398ce5baef7e3533895bd51b22", "b468dff916ecb5c38077c6a12bee3c4c", "d3c633412ef9a04b842164d87c639164", "ada9b8bfd4494016f1b0528fe22b15e7",
  "76cdbeee8e5fedeb61e532b1670b9731", "c020955557711b83469857220d0c09ac", "c2e117bf5b7be266a41aa62277030cc2", "a862727c8f7d01444f755b06225c2005",
  "3693222b4a83f47312a71f59ac654a67", "848f0450e4742b81bd3f8c1a6c236e42", "f8aaddde0098aecb855d753708053af4", "d9ca489b880445e538456db94f4aeb1a",
  "77a9b43fec7522c22dcfe7d5870bb777", "ebe20e698a284720d43d4cff6645c8bf", "d48149db6bb0162d24fdc94714601651", "7c7b9cf588736dac0830c7ba0276a1b9",
  "1d5667cfd8ba1ac7b94ebbcfa67ecade", "65dd80bab082ee09571ed81178d70cf8", "98110e6e5b054f80106b96dd14b5ddc2", "80bc62a9ad021b32136ec69ac2357ee6",
  "f671f8fe3a78f56b0fb0989acc31906b", "1d9871e832ecd0f658aee91ae2f52dde", "1e38dd4541ed04fc2d1a424f936c1811", "39435d03f5769bae916092fa55ba1e30",
  "8b8a48bff7de48e0fd0cc2d94babe7a4", "78ace1f1d83dcfe60a6c634028e31c5e", "f6b4cc4b3975e93cc920e694dcd5d9c2", "18a3d7cf8f593907c92fc6462c8af489",
];
const REF_M420 = [
  "32400f91e0e26dc00fdcce0ded55cf5e", "4c16dd5bd7c3d93ae12ff8a19b359971", "4c16dd5bd7c3d93ae12ff8a19b359971", "494e602a22664c2d3217a0f843d4a007",
  "7bd958a628406529fb93d23193e06cf7", "c535528960076cfd94d91e9c05c2dcd0", "64dce9e019768a2d4264080af69d5bf2", "543db71e991f2f561e09478f13c31d24",
  "2ac3e10d2a86a62acfc7df0189fb6d27", "cf62b96e5dcd32f4a0bd9ea64f5cc057", "ebb8e02b8375858530ad47f40a64fb36", "18da617767167622be6c1ef9d3c750f6",
  "3a1011be0f8fad1fd63507b761840430", "63a1c3c408ed9a8148ae2b704aa7cf9e", "bf96cb0fca7218ba666b8e92c84cd5bc", "1a1917222e52f474ee7d4df769f25321",
  "8bb259a63be46636fbe768550a118606", "b302ef1eb0b2a2e1b5d88a78cf25d964", "26208eff3ad0317f905078fd1849e19d", "a7a53649fcd3d9e61778afc6f07f792b",
  "8b38a30d93c9aec9991738261f953ce5", "d3a3d45cc22587e15fcfcab19a11fbd0", "194c0434f584cd786e59b9662844eb4d", "dc11667a65b5d8fc7d9fa02673a771cf",
  "2b338262fad4d049e3d393cb13767821", "409b4a892c6b9193b3fbefb2f13bc6d2", "e19d587547874057c729d76bb93c9115", "61723e206e461f209d7d0e7e7cd9db77",
  "107d6bedd4e9c8e31b4917b80eea2068", "b356d28bba999629e446ff987fb6ac75", "2c9ac9ae77a0506d0b6d5fdd3f6a904a", "4b12bcb19a21c26460ccd7cfe1ef0bce",
  "df1c23b848f045f7a1bc67d3cc2b5c58", "8c38d69cf4f5d19fd1cc6bc723c4fa87", "d517ced399994f2491db33b9b874ee0f", "f4107e947bbcb9ac240319a443eca10c",
  "245c09b163a9336c5096310d9e8af9dd", "f66b1c7a19f3394824e23cc0b4134fe6", "eb33a69f3ab2b54baefeadf4a79256c8", "3b04a9c99d0689208b5896fa5a5078a1",
  "7fc56baff97d5da2254e8720da407cef", "e0522bdeb913f74ced628aa4356d2e14", "ab6b513b6265d1c90af81cbfd7297662", "6dbe887f31b7e62ec8ea6abcb9ba71fd",
  "c4cc3cbbbcb251270c0711caf497c4e1", "7b3041c0b5963a523e09b467d462a65c", "fe33ca6ec68659eb46c48e669479b11c", "6da7d0abdfacd6bc0b6b42a2a539639b",
  "6066ed6464a31a49dd35df990e1a2b65", "5a951c7a77fcc3da97bd0f2533d2fbed", "b50934c14396a8efb9fb4d286e4af900", "36484a6782ca725395669d326071c72f",
  "5f0e983056f8925f44a227b3dd054cdd", "6d9705009725f57cdabe64bdd1c2a70f", "13b2f1adc90fecf34f7f1fb7e15896d8", "881bc2413846347d9ee93b51dc5addac",
  "accf34c6c7c63f7462966c6acad72550", "0875c20c91b2ae554420ad504bd947dd", "2ede144c95210322f061f03c9b11d8b5", "f40146083286202bb65b8a4badff206a",
  "0d879182ec8b803dea164ca930473b23", "b3c5d3e5ec5a6c84b28942fbb7454e91", "4000a48499c2790d45169251133649a0", "4d37c2a7d5fabab798dd8b6782f7086a",
  "ec4b43c3605450db190a8852d9233e26", "1b085d4c6d6506d3d5f61964c9e39884", "0ec80b80fbad4f509dce57032c7ef800", "39450380ef192ba0a69cd0a512bab443",
  "70e2ffeaf475a810f59e44b7ac7e41cc", "e0d3e22696f57b4f1ffa0ad8806d1cd6", "7b4e08ce54c06a2a36b9b17848a17b36", "fbcc6b534257a242295e6579b3388383",
  "aadf76d69163844fce80a76ae0d2ef47", "028fb0f8989f23e4d345a2aa96f3be36", "a9a87745c282e84000ad9947aeab4e07", "ded8f9aeb330dac35c2d728b94475e2d",
];
// Moyennes natives [Y,U,V] par frame (422/444 : rééchantillonnage C vs SIMD, tolérance).
const REF_M422_MEANS = [[127.01, 126.8, 124.26], [127.12, 126.76, 124.34], [127.24, 126.72, 124.3], [127.28, 126.78, 124.37], [127.32, 126.8, 124.36], [127.31, 126.86, 124.43], [127.31, 126.93, 124.51], [127.31, 127, 124.58], [127.3, 127.07, 124.49], [127.29, 127.16, 124.37], [127.31, 127.23, 124.27], [127.28, 127.29, 124.17], [127.25, 127.4, 124.14], [127.29, 127.37, 124.09], [127.35, 127.25, 124.12], [127.33, 127.23, 124.23], [127.35, 127.11, 124.32], [127.36, 127.05, 124.42], [127.38, 126.95, 124.42], [127.37, 126.93, 124.37], [127.42, 126.8, 124.27], [127.38, 126.75, 124.27], [127.36, 126.69, 124.31], [127.34, 126.62, 124.21], [127.36, 126.54, 124.1]];
const REF_M444_MEANS = [[127.01, 126.78, 124.23], [127.12, 126.75, 124.31], [127.24, 126.71, 124.27], [127.28, 126.77, 124.34], [127.32, 126.78, 124.33], [127.31, 126.85, 124.4], [127.31, 126.91, 124.49], [127.31, 126.99, 124.55], [127.3, 127.05, 124.46], [127.29, 127.14, 124.35], [127.31, 127.22, 124.24], [127.28, 127.28, 124.14], [127.25, 127.39, 124.12], [127.29, 127.35, 124.06], [127.35, 127.24, 124.09], [127.33, 127.21, 124.2], [127.35, 127.1, 124.29], [127.36, 127.04, 124.4], [127.38, 126.94, 124.4], [127.37, 126.92, 124.34], [127.42, 126.79, 124.24], [127.38, 126.74, 124.24], [127.36, 126.69, 124.27], [127.34, 126.6, 124.18], [127.36, 126.52, 124.06]];
// Nos MD5 (déterminisme du build WASM versionné).
const OUR_M422 = [
  "6661ba472a4054ea0e2de17afd08b93f", "ed25100c6bcb1817b28636afd38127e8", "49a2180ad2c5249a156170406097245a", "7fdce2a63df3c6304fb1b2360ff4c857",
  "4cdb48cc82b2670997324bb2f80a98c7", "1a5a8bbe5c1a8143bfc7d4a18bf5f75f", "72e377c1fd61cceaf295fb8726615356", "ea7a06ba2218fef695f87af241cc8520",
  "e89445fabe24b160728e4c5eaf656479", "6a47316c2787516637e726b187eca59b", "e4778d694e0c57956505d4de9a782604", "c8b7af5a32ff7da91c00f239cf713230",
  "bbd56f1c4e217691cdd7f1fd454d4022", "1c99bf3e3bab2c9da885b4c001304106", "f4af9d8810e8b6c361492df629670128", "a8ee00b474e59a9e3f47b61619ac255d",
  "af1b53675ca1114dd13e5c89a824272b", "be17c7dc8d9f8fcfca16226d7add15ad", "688aed0c22057f36a68954694384e81f", "508874d5553bc6de1ed93bcbc961444e",
  "42dc023282a03d2c10015a8f456fbdfb", "42803cd7eb210a29479aa42973813066", "9b34c41efbbbca99782674dd882ef41b", "af49c64f8d4824c6a46ded1cc94df800",
  "afe063f02e11828f3a535c247ac0a1b9",
];
const OUR_M444 = [
  "28d1d00f80845dd775a8f8dd513b0c4b", "f34b729922a76d2bf9d3a268a9d0836a", "6788cf48e89153dc1379455055563b0f", "8a7b078424269365295151cd55ed70ee",
  "adaf6822f5552878d3bf5c97d5a25089", "a9d37e9aecabff06a9051ba0b64e302b", "3b00dc907d2f53b9b23e369cec0af22c", "7b2c62cc1cc7f82c0c58bd49c3817d14",
  "39ede1d2f05c9c9448c713ef6c7f12c5", "bac28843aa4df4e2b1a0e728c6c0d6ad", "0546a1e1029108cc3485ab6e79e1dd12", "b2cc8b390dc1ef88baece540c4894849",
  "d66a386538f3147da53b9f59395d983a", "de673796a259dc6e6c380622f47b855f", "f0db0221e59197571ea4fa2830d00325", "5307933ac5c6434fa0458f97e23970a3",
  "bc663668faba7af6eb563485db67b484", "2eb2dce07d3ae2f40aeaefc49f827c82", "44f2b0403c3dd2d70bbff66344d2e4e3", "11d65ea8b3e2ee1701c35be6957df8ae",
  "0901a3e11ddee5ebf851777d5bf3fec0", "7384fd1eda2f86c13f12dca7dfea42d5", "cb98a12d5a64efa0f6d8cdb2b45cdbd7", "02dac3b9cfb5dd031ec88d71fddf4155",
  "b85d78aa559e8569b2b02047edf206a4",
];

// Mapping référence : doublon natif en position 2 (chunk vide ffmpeg).
// Si la réf a une frame de plus (le doublon), on saute l'index 2.
const refIdx = (i, refLen, oursLen) => (refLen === oursLen + 1 && i >= 2 ? i + 1 : i);

async function openAviPackets(path) {
  const data = await readFile(path);
  const lib = new CompatLib();
  const name = "t.avi";
  await lib.mkblockreaderdev(name, data.length);
  lib.onblockread = async (filename, pos, _len) => {
    const start = Math.floor(pos / 1048576) * 1048576;
    const end = Math.min(data.length, start + 1048576);
    await lib.ff_block_reader_dev_send(name, start, data.subarray(start, end));
  };
  const [session, streams] = await ff_init_demuxer_file(lib, name);
  const v = streams.find((s) => s.codec_type === AVMEDIA_TYPE_VIDEO);
  const pkts = [];
  for (let i = 0; i < 60; i++) {
    const [res, dict] = await ff_read_frame_multi(session, {}, { limit: 262144 });
    if (res === AVERROR_EOF) break;
    pkts.push(...(dict[v.index] ?? []));
  }
  return { v, pkts };
}

async function decodeAll(codecpar, codec, pkts) {
  const s = await createMP4VSession(codecpar, codec);
  const out = [];
  try {
    let t = 0;
    for (const p of pkts) {
      for (const f of s.decode(p.data, t)) out.push(f);
      t += 40000;
    }
    for (const f of s.drain()) out.push(f);
  } finally {
    s.destroy();
  }
  return out;
}

function frameMeans(f, w, h) {
  const uvW = (w + 1) >> 1, uvH = (h + 1) >> 1, yS = w * h, uS = uvW * uvH;
  const m = [0, 0, 0];
  for (let i = 0; i < yS; i++) m[0] += f.data[i];
  for (let i = 0; i < uS; i++) { m[1] += f.data[yS + i]; m[2] += f.data[yS + uS + i]; }
  return [m[0] / yS, m[1] / uS, m[2] / uS];
}

describe("sw-decode-mp4v", () => {
  it("xvid → 75 frames 640x360 bit-exactes vs natif", async () => {
    const { v, pkts } = await openAviPackets(FIX("avi-xvid-mp3.avi"));
    assert.equal(pkts.length, 75);
    const frames = await decodeAll(v.codecpar, "mpeg4", pkts);
    assert.equal(frames.length, REF_XVID.length - 1); // -1 : doublon natif
    for (const f of frames) {
      assert.equal(f.format, 0);
      assert.equal(f.width, 640);
      assert.equal(f.height, 360);
      assert.equal(f.data.length, 640 * 360 * 3 / 2);
    }
    frames.forEach((f, i) => assert.equal(md5(f.data), REF_XVID[refIdx(i, REF_XVID.length, frames.length)], `frame ${i}`));
  });

  it("h263 → 75 frames 352x288 bit-exactes vs natif", async () => {
    const { v, pkts } = await openAviPackets(FIX("avi-h263-mp3.avi"));
    assert.equal(pkts.length, 75);
    const frames = await decodeAll(v.codecpar, "h263", pkts);
    assert.equal(frames.length, REF_H263.length - 1);
    frames.forEach((f, i) => {
      assert.equal(f.width, 352);
      assert.equal(f.height, 288);
      assert.equal(md5(f.data), REF_H263[refIdx(i, REF_H263.length, frames.length)], `frame ${i}`);
    });
  });

  it("mjpeg 420 → 75 frames bit-exactes vs natif", async () => {
    const { v, pkts } = await openAviPackets(FIX("avi-mjpeg-420.avi"));
    const frames = await decodeAll(v.codecpar, "mjpeg", pkts);
    assert.equal(frames.length, REF_M420.length - 1);
    frames.forEach((f, i) => assert.equal(md5(f.data), REF_M420[refIdx(i, REF_M420.length, frames.length)], `frame ${i}`));
  });

  it("mjpeg 422/444 → contenu fidèle (moyennes) + déterminisme", async () => {
    for (const [fix, means, ours, n] of [
      ["avi-mjpeg-422.avi", REF_M422_MEANS, OUR_M422, 25],
      ["avi-mjpeg-444.avi", REF_M444_MEANS, OUR_M444, 25],
    ]) {
      const { v, pkts } = await openAviPackets(FIX(fix));
      const frames = await decodeAll(v.codecpar, "mjpeg", pkts);
      assert.equal(frames.length, n);
      frames.forEach((f, i) => {
        assert.equal(md5(f.data), ours[i], `${fix} frame ${i} (déterminisme)`);
        const m = frameMeans(f, 640, 360);
        for (let c = 0; c < 3; c++) {
          assert.ok(Math.abs(m[c] - means[i][c]) < 1.0, `${fix} f${i} voie${c} : ${m[c].toFixed(2)} vs ${means[i][c]}`);
        }
      });
    }
  });

  it("reset() → reprise déterministe bit-exacte (depuis une clé)", async () => {
    const { v, pkts } = await openAviPackets(FIX("avi-xvid-mp3.avi"));
    const ref = await decodeAll(v.codecpar, "mpeg4", pkts);
    // Reprise post-seek = depuis une keyframe (comme le demux : recul clé).
    const at = pkts.findIndex((p, i) => i >= 20 && p.key);
    assert.ok(at > 0, "clé trouvée");
    const s = await createMP4VSession(v.codecpar, "mpeg4");
    try {
      let t = 0;
      for (const p of pkts.slice(0, at)) { s.decode(p.data, t); t += 40000; }
      await avcodec_flush_buffers({ reset: () => s.reset() });
      const tail = [];
      for (const p of pkts.slice(at)) {
        for (const f of s.decode(p.data, t)) tail.push(f);
        t += 40000;
      }
      assert.equal(tail.length, ref.length - at);
      tail.forEach((f, i) => assert.equal(md5(f.data), md5(ref[at + i].data), `reprise ${i}`));
    } finally {
      s.destroy();
    }
  });

  it("wiring compat : ff_init_decoder mp4v/h263/mjpeg + build msmpeg4", async () => {
    const { v } = await openAviPackets(FIX("avi-xvid-mp3.avi"));
    const [, ctx] = await ff_init_decoder(12, v.codecpar);
    try {
      const out = await ff_decode_multi(ctx, {}, {}, []);
      assert.ok(Array.isArray(out));
    } finally {
      await ff_free_decoder(ctx);
    }
    // Décodeurs du build, sans fixture (pas d'encodeur) : création OK.
    // (le v3 s'enregistre "msmpeg4" côté FFmpeg, particularité couverte ici)
    for (const [family, decoder] of [["h263", "h263"], ["msmpeg4v1", "msmpeg4v1"],
        ["msmpeg4v2", "msmpeg4v2"], ["msmpeg4v3", "msmpeg4"]]) {
      const s = await createMP4VSession({ family, width: 352, height: 288 }, decoder);
      s.destroy();
    }
    await assert.rejects(ff_init_decoder(99, {}), /non migré|invalide|SW fallback/);
  });
});
