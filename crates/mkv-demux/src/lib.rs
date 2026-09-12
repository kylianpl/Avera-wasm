//! mpv-web-demux — coeur WASM (source de vérité).
//! Miroir Rust de packages/mkv-demux (JS). Build: wasm-pack build --target web.
//! Règles: u64/i64 partout pour offsets/temps, jamais f64 sauf sample_rate.
//! Temps en ns i64 + timecode_scale u64. Unknown-size EBML supporté.

use js_sys::{Array, Uint8Array};
use wasm_bindgen::prelude::*;

fn err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

struct R<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> R<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, p: 0 }
    }
    fn eof(&self) -> bool {
        self.p >= self.b.len()
    }
    fn u8(&mut self) -> Result<u8, String> {
        if self.p >= self.b.len() {
            return Err("eof".into());
        }
        let v = self.b[self.p];
        self.p += 1;
        Ok(v)
    }
    fn width(first: u8) -> Result<usize, String> {
        if first & 0x80 != 0 {
            Ok(1)
        } else if first & 0x40 != 0 {
            Ok(2)
        } else if first & 0x20 != 0 {
            Ok(3)
        } else if first & 0x10 != 0 {
            Ok(4)
        } else if first & 0x08 != 0 {
            Ok(5)
        } else if first & 0x04 != 0 {
            Ok(6)
        } else if first & 0x02 != 0 {
            Ok(7)
        } else if first & 0x01 != 0 {
            Ok(8)
        } else {
            Err("bad vint".into())
        }
    }
    fn id(&mut self) -> Result<(u32, usize), String> {
        let b0 = *self.b.get(self.p).ok_or("eof id")?;
        let l = Self::width(b0)?;
        if self.p + l > self.b.len() {
            return Err("trunc id".into());
        }
        let mut v = 0u32;
        for i in 0..l {
            v = (v << 8) | self.b[self.p + i] as u32;
        }
        self.p += l;
        Ok((v, l))
    }
    /// None = unknown-size (all-ones)
    fn vint(&mut self) -> Result<(Option<u64>, usize), String> {
        let b0 = *self.b.get(self.p).ok_or("eof vint")?;
        let l = Self::width(b0)?;
        if self.p + l > self.b.len() {
            return Err("trunc vint".into());
        }
        let mask = if l == 8 { 0u8 } else { (1u8 << (8 - l)) - 1 };
        let mut v = (b0 & mask) as u64;
        for i in 1..l {
            v = (v << 8) | self.b[self.p + i] as u64;
        }
        self.p += l;
        let max = ((1u128 << (7 * l)) - 1) as u64;
        if v == max {
            Ok((None, l))
        } else {
            Ok((Some(v), l))
        }
    }
    fn uint(&mut self, n: usize) -> Result<u64, String> {
        if self.p + n > self.b.len() {
            return Err("trunc uint".into());
        }
        let mut v = 0u64;
        for i in 0..n {
            v = (v << 8) | self.b[self.p + i] as u64;
        }
        self.p += n;
        Ok(v)
    }
    fn skip(&mut self, n: usize) -> Result<(), String> {
        if self.p + n > self.b.len() {
            return Err("trunc skip".into());
        }
        self.p += n;
        Ok(())
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.p + n > self.b.len() {
            return Err("trunc bytes".into());
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn f64v(&mut self, n: usize) -> Result<f64, String> {
        let b = self.bytes(n)?;
        Ok(match n {
            4 => f32::from_be_bytes(b.try_into().unwrap()) as f64,
            8 => f64::from_be_bytes(b.try_into().unwrap()),
            _ => return Err("bad float".into()),
        })
    }
    fn vint_val(&mut self) -> Result<u64, String> {
        Ok(self.vint()?.0.ok_or("unknown not allowed")?)
    }
}

fn elem(r: &mut R) -> Result<(u32, Option<u64>), String> {
    let (id, _) = r.id()?;
    let (sz, _) = r.vint()?;
    Ok((id, sz))
}

#[inline]
pub fn ticks_to_ns(t: i64, s: u64) -> i64 {
    (t as i128 * s as i128) as i64
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Clone, Default)]
pub struct ProbeInfo {
    pub seg_off: u64,
    pub scale: u64,
    pub dur_ns: i64,
    pub doc_type: String,
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Clone, Default)]
pub struct TrackEntry {
    pub number: u64,
    pub uid: u64,
    pub kind: u8,
    pub flag_default: bool,
    pub flag_forced: bool,
    pub codec_id: String,
    pub lang: String,
    pub name: String,
    pub def_dur_ns: u64,
    pub width: u64,
    pub height: u64,
    pub channels: u64,
    pub sample_rate: f64,
    #[wasm_bindgen(skip)]
    pub priv_data: Vec<u8>,
}

#[wasm_bindgen]
impl TrackEntry {
    #[wasm_bindgen(getter, js_name = codecPrivate)]
    pub fn priv_view(&self) -> Uint8Array {
        Uint8Array::from(&self.priv_data[..])
    }
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Clone, Default)]
pub struct ChapterAtom {
    pub uid: u64,
    pub start_ns: i64,
    pub end_ns: i64,
    pub hidden: bool,
    pub enabled: bool,
    pub title: String,
    pub lang: String,
}

#[wasm_bindgen]
#[derive(Clone, Default)]
pub struct CuePoint {
    pub time_ns: i64,
    pub track: u64,
    pub cluster_pos: u64,
    pub rel_pos: u64,
    pub block_no: u32,
    pub dur_ns: i64,
}

#[wasm_bindgen]
#[derive(Clone, Default)]
pub struct WasmBlock {
    pub track: u64,
    pub pts_ns: i64,
    pub dur_ns: i64,
    pub key: bool,
    pub invisible: bool,
    pub data_off: u32,
    pub data_len: u32,
    #[wasm_bindgen(skip)]
    pub fo: Vec<u32>,
    #[wasm_bindgen(skip)]
    pub fl: Vec<u32>,
}

#[wasm_bindgen]
impl WasmBlock {
    #[wasm_bindgen(getter, js_name = frameOffs)]
    pub fn fo_get(&self) -> Vec<u32> {
        self.fo.clone()
    }
    #[wasm_bindgen(getter, js_name = frameLens)]
    pub fn fl_get(&self) -> Vec<u32> {
        self.fl.clone()
    }
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Clone, Default)]
pub struct SubCue {
    pub start_ns: i64,
    pub end_ns: i64,
    pub text: String,
    pub style: String,
}

fn parse_tracks_inner(b: &[u8]) -> Result<Vec<TrackEntry>, String> {
    let mut r = R::new(b);
    let mut out = vec![];
    while !r.eof() {
        let (id, sz) = elem(&mut r)?;
        let end = sz.map(|s| r.p + s as usize).unwrap_or(b.len());
        if id == 0xAE {
            out.push(parse_entry(&mut r, end)?);
        }
        r.p = end.min(b.len());
    }
    Ok(out)
}

fn parse_entry(r: &mut R, end: usize) -> Result<TrackEntry, String> {
    let mut t = TrackEntry::default();
    t.lang = "eng".into();
    while r.p < end {
        let (id, sz) = elem(r)?;
        let de = sz.map(|s| r.p + s as usize).unwrap_or(end);
        let n = sz.unwrap_or(0) as usize;
        match id {
            0xD7 => t.number = r.uint(n)?,
            0x73C5 => t.uid = r.uint(n)?,
            0x83 => t.kind = r.uint(n)? as u8,
            0x88 => t.flag_default = r.uint(n)? != 0,
            0x55AA => t.flag_forced = r.uint(n)? != 0,
            0x86 => t.codec_id = String::from_utf8_lossy(r.bytes(n)?).into_owned(),
            0x22B59C => t.lang = String::from_utf8_lossy(r.bytes(n)?).into_owned(),
            0x536E => t.name = String::from_utf8_lossy(r.bytes(n)?).into_owned(),
            0x23E383 => t.def_dur_ns = r.uint(n)?,
            0x63A2 => t.priv_data = r.bytes(n)?.to_vec(),
            0xE0 => {
                while r.p < de {
                    let (i, s) = elem(r)?;
                    let nn = s.unwrap_or(0) as usize;
                    match i {
                        0xB0 => t.width = r.uint(nn)?,
                        0xBA => t.height = r.uint(nn)?,
                        _ => {
                            r.skip(nn)?;
                        }
                    }
                }
            }
            0xE1 => {
                while r.p < de {
                    let (i, s) = elem(r)?;
                    let nn = s.unwrap_or(0) as usize;
                    match i {
                        0x9F => t.channels = r.uint(nn)?,
                        0xB5 => t.sample_rate = r.f64v(nn)?,
                        _ => {
                            r.skip(nn)?;
                        }
                    }
                }
            }
            _ => {
                r.skip(n)?;
            }
        }
        r.p = de.min(r.b.len());
    }
    Ok(t)
}

fn parse_chap_inner(b: &[u8]) -> Result<Vec<ChapterAtom>, String> {
    let mut r = R::new(b);
    let mut out = vec![];
    while !r.eof() {
        let (id, sz) = elem(&mut r)?;
        let end = sz.map(|s| r.p + s as usize).unwrap_or(b.len());
        if id == 0x45B9 {
            let mut er = R::new(&r.b[r.p..end.min(r.b.len())]);
            while !er.eof() {
                let (a, s2) = elem(&mut er)?;
                let e2 = s2.map(|s| er.p + s as usize).unwrap_or(end - r.p);
                if a == 0xB6 {
                    let mut c = ChapterAtom::default();
                    c.enabled = true;
                    while er.p < e2 {
                        let (f, s3) = elem(&mut er)?;
                        let nn = s3.unwrap_or(0) as usize;
                        match f {
                            0x73C4 => c.uid = er.uint(nn)?,
                            0x91 => c.start_ns = er.uint(nn)? as i64,
                            0x92 => c.end_ns = er.uint(nn)? as i64,
                            0x98 => c.hidden = er.uint(nn)? != 0,
                            0x4598 => c.enabled = er.uint(nn)? != 0,
                            0x80 => {
                                let de3 = er.p + nn;
                                while er.p < de3 {
                                    let (g, s4) = elem(&mut er)?;
                                    let n4 = s4.unwrap_or(0) as usize;
                                    if g == 0x85 {
                                        c.title =
                                            String::from_utf8_lossy(er.bytes(n4)?).into_owned()
                                    } else {
                                        er.skip(n4)?
                                    }
                                }
                            }
                            _ => er.skip(nn)?,
                        }
                    }
                    out.push(c);
                }
                er.p = e2;
            }
        }
        r.p = end.min(b.len());
    }
    Ok(out)
}

#[wasm_bindgen(js_name = openProbe)]
pub fn open_probe(b: &[u8]) -> Result<ProbeInfo, JsValue> {
    let mut r = R::new(b);
    let mut o = ProbeInfo {
        scale: 1_000_000,
        dur_ns: -1,
        ..Default::default()
    };
    while !r.eof() {
        let (id, sz) = elem(&mut r).map_err(err)?;
        let end = sz.map(|s| r.p + s as usize).unwrap_or(b.len());
        match id {
            0x1A45DFA3 => {
                while r.p < end {
                    let (f, s) = elem(&mut r).map_err(err)?;
                    let n = s.unwrap_or(0) as usize;
                    match f {
                        0x4282 => {
                            o.doc_type =
                                String::from_utf8_lossy(r.bytes(n).map_err(err)?).into_owned()
                        }
                        _ => r.skip(n).map_err(err)?,
                    }
                }
            }
            0x18538067 => {
                o.seg_off = r.p as u64;
                break;
            }
            _ => {
                if let Some(s) = sz {
                    r.skip(s as usize).map_err(err)?
                } else {
                    break;
                }
            }
        }
        r.p = end.min(b.len());
    }
    if o.seg_off == 0 {
        return Err(err("Segment not found in probe window"));
    }
    Ok(o)
}

#[wasm_bindgen(js_name = parseTracks)]
pub fn parse_tracks(b: &[u8]) -> Result<Array, JsValue> {
    let v = parse_tracks_inner(b).map_err(err)?;
    let a = Array::new();
    for t in v {
        a.push(&JsValue::from(t));
    }
    Ok(a)
}

#[wasm_bindgen(js_name = parseChapters)]
pub fn parse_chapters(b: &[u8]) -> Result<Array, JsValue> {
    let v = parse_chap_inner(b).map_err(err)?;
    let a = Array::new();
    for c in v {
        a.push(&JsValue::from(c));
    }
    Ok(a)
}

#[wasm_bindgen(js_name = ticksToNs)]
pub fn ticks_to_ns_js(t: i64, s: u64) -> i64 {
    ticks_to_ns(t, s)
}

// ---- Phase 1B : lecture paquets (clusters/blocs) ----

/// Largeur EBML signée (lacing) : retourne (valeur non signée brute, largeur).
fn lace_width(first: u8) -> Result<usize, String> {
    R::width(first)
}

/// Découpe les frames d'un Block. Retourne (off, len) relatifs au payload.
/// Miroir exact de packages/mkv-demux/src/lacing.js (splitLacing).
fn split_lacing(payload: &[u8], lace_type: u8, frame_count: usize, header_len: usize) -> Result<Vec<(usize, usize)>, String> {
    if frame_count == 0 {
        return Err("frameCount must be > 0".into());
    }
    if header_len > payload.len() {
        return Err("trunc lace header".into());
    }
    if lace_type == 0 {
        if frame_count != 1 {
            return Err("no-lace must have 1 frame".into());
        }
        return Ok(vec![(header_len, payload.len() - header_len)]);
    }
    if lace_type == 2 {
        let total = payload.len() - header_len;
        if total % frame_count != 0 {
            return Err("fixed lace size mismatch".into());
        }
        let s = total / frame_count;
        return Ok((0..frame_count).map(|i| (header_len + i * s, s)).collect());
    }
    if lace_type == 1 {
        // Xiph : n-1 tailles en octets 255-chaînés.
        let mut sizes = vec![];
        let mut p = header_len;
        for _ in 0..frame_count - 1 {
            let mut v = 0usize;
            loop {
                if p >= payload.len() {
                    return Err("trunc xiph lace".into());
                }
                let b = payload[p];
                p += 1;
                v += b as usize;
                if b != 255 {
                    break;
                }
            }
            sizes.push(v);
        }
        let mut frames = vec![];
        let mut off = p;
        for i in 0..frame_count {
            let len = if i + 1 < frame_count { sizes[i] } else { payload.len() - off };
            if off + len > payload.len() {
                return Err("xiph lace overflow".into());
            }
            frames.push((off, len));
            off += len;
        }
        return Ok(frames);
    }
    // EBML : 1ère taille unsigned, suivantes signées avec biais.
    let mut sizes: Vec<i64> = vec![];
    let mut p = header_len;
    let read_ebml_lace = |p: &mut usize, payload: &[u8]| -> Result<(u64, usize), String> {
        if *p >= payload.len() {
            return Err("trunc ebml lace".into());
        }
        let w = lace_width(payload[*p])?;
        if *p + w > payload.len() {
            return Err("trunc ebml lace size".into());
        }
        let mask: u64 = if w == 8 { 0 } else { (1u64 << (8 - w)) - 1 };
        let mut v = (payload[*p] as u64) & mask;
        for k in 1..w {
            v = (v << 8) | payload[*p + k] as u64;
        }
        *p += w;
        Ok((v, w))
    };
    let (v0, _) = read_ebml_lace(&mut p, payload)?;
    if v0 > i64::MAX as u64 {
        return Err("ebml lace size too big".into());
    }
    let mut acc = v0 as i64;
    sizes.push(acc);
    for _ in 1..frame_count - 1 {
        let (uv, w) = read_ebml_lace(&mut p, payload)?;
        let bias = ((1u64 << (7 * w - 1)) - 1) as i64;
        acc += uv as i64 - bias;
        if acc < 0 {
            return Err("ebml lace negative size".into());
        }
        sizes.push(acc);
    }
    let mut frames = vec![];
    let mut off = p;
    for i in 0..frame_count {
        let len = if i + 1 < frame_count { sizes[i] as usize } else { payload.len() - off };
        if off + len > payload.len() {
            return Err("ebml lace overflow".into());
        }
        frames.push((off, len));
        off += len;
    }
    Ok(frames)
}

struct ParsedBlock {
    track: u64,
    pts_ns: i64,
    key: bool,
    frames: Vec<(usize, usize)>,
}

/// Parse un payload SimpleBlock/Block (SANS id/size). Miroir de blocks.js.
fn parse_block_payload(payload: &[u8], cluster_ticks: i64, scale: u64) -> Result<ParsedBlock, String> {
    let mut r = R::new(payload);
    // track : vint (valeur, pas de unknown-size ici)
    let b0 = *payload.get(0).ok_or("short block")?;
    let w = R::width(b0)?;
    if 1 + w > payload.len() {
        return Err("trunc trackno".into());
    }
    let mask = if w == 8 { 0u8 } else { (1u8 << (8 - w)) - 1 };
    let mut track = (b0 & mask) as u64;
    for i in 1..w {
        track = (track << 8) | payload[i] as u64;
    }
    r.p = w;
    if r.p + 3 > payload.len() {
        return Err("short block".into());
    }
    let ts = i16::from_be_bytes([payload[r.p], payload[r.p + 1]]) as i64;
    r.p += 2;
    let flags = payload[r.p];
    r.p += 1;
    let key = flags & 0x80 != 0;
    let lace = (flags >> 1) & 0x03;
    let mut frame_count = 1usize;
    let mut header_len = r.p;
    if lace != 0 {
        if r.p >= payload.len() {
            return Err("trunc lace count".into());
        }
        frame_count = payload[r.p] as usize + 1;
        r.p += 1;
        header_len = r.p;
    }
    let frames = split_lacing(payload, lace, frame_count, header_len)?;
    let pts_ns = ticks_to_ns(cluster_ticks + ts, scale);
    Ok(ParsedBlock { track, pts_ns, key, frames })
}

/// Parse un payload Cluster COMPLET → Array de paquets JS.
/// Chaque paquet : {track, ptsNs, durNs, key, data:Uint8Array, frames:[{off,len}]}.
/// data = copie du payload du bloc (les frames sont des vues via off/len).
#[wasm_bindgen(js_name = parseCluster)]
pub fn parse_cluster(payload: &[u8], timecode_scale: u64) -> Result<Array, JsValue> {
    let out = Array::new();
    let mut r = R::new(payload);
    let mut cluster_ticks: Option<i64> = None;
    while !r.eof() {
        let start = r.p;
        let (id, sz) = match elem(&mut r) {
            Ok(x) => x,
            Err(_) => break,
        };
        let end = match sz {
            Some(s) => (r.p + s as usize).min(payload.len()),
            None => payload.len(),
        };
        if id == 0xE7 {
            // Timecode (uint, taille connue en pratique)
            let n = end - r.p;
            cluster_ticks = Some(r.uint(n).map_err(err)? as i64);
        } else if id == 0xA3 {
            if let Some(ct) = cluster_ticks {
                let bp = &payload[r.p..end];
                let b = parse_block_payload(bp, ct, timecode_scale).map_err(err)?;
                push_packet(&out, &b, bp, 0)?;
            }
        } else if id == 0xA0 {
            if cluster_ticks.is_none() {
                r.p = if end <= start { start + 1 } else { end };
                continue;
            }
            let ct = cluster_ticks.unwrap();
            let grp = &payload[r.p..end];
            let mut gr = R::new(grp);
            let mut block_payload: Option<&[u8]> = None;
            let mut dur_ticks: i64 = 0;
            let mut has_ref = false;
            while !gr.eof() {
                let gs = gr.p;
                let (gid, gsz) = match elem(&mut gr) {
                    Ok(x) => x,
                    Err(_) => break,
                };
                let gend = match gsz {
                    Some(s) => (gr.p + s as usize).min(grp.len()),
                    None => grp.len(),
                };
                if gid == 0xA1 && block_payload.is_none() {
                    block_payload = Some(&grp[gr.p..gend]);
                } else if gid == 0x9B {
                    let n = gend - gr.p;
                    dur_ticks = gr.uint(n).map_err(err)? as i64;
                } else if gid == 0xFB {
                    has_ref = true;
                }
                gr.p = if gend <= gs { gs + 1 } else { gend };
            }
            if let Some(bp) = block_payload {
                let mut b = parse_block_payload(bp, ct, timecode_scale).map_err(err)?;
                b.key = !has_ref;
                push_packet(&out, &b, bp, dur_ticks * timecode_scale as i64)?;
            }
        }
        r.p = if end <= start { start + 1 } else { end };
    }
    Ok(out)
}

fn push_packet(out: &Array, b: &ParsedBlock, payload: &[u8], dur_ns: i64) -> Result<(), JsValue> {
    use js_sys::{Object, Reflect};
    let o = Object::new();
    Reflect::set(&o, &"track".into(), &JsValue::from_f64(b.track as f64))?;
    Reflect::set(&o, &"ptsNs".into(), &JsValue::from_f64(b.pts_ns as f64))?;
    Reflect::set(&o, &"durNs".into(), &JsValue::from_f64(dur_ns as f64))?;
    Reflect::set(&o, &"key".into(), &JsValue::from_bool(b.key))?;
    Reflect::set(&o, &"data".into(), &Uint8Array::from(payload))?;
    let fa = Array::new();
    for (off, len) in &b.frames {
        let fo = Object::new();
        Reflect::set(&fo, &"off".into(), &JsValue::from_f64(*off as f64))?;
        Reflect::set(&fo, &"len".into(), &JsValue::from_f64(*len as f64))?;
        fa.push(&fo);
    }
    Reflect::set(&o, &"frames".into(), &fa)?;
    out.push(&o);
    Ok(())
}

/// Parse un payload Cues → Array [{timeNs, track, clusterPos}].
#[wasm_bindgen(js_name = parseCues)]
pub fn parse_cues(payload: &[u8], timecode_scale: u64) -> Result<Array, JsValue> {
    let out = Array::new();
    let mut pts: Vec<(i64, u64, u64)> = vec![];
    let mut r = R::new(payload);
    while !r.eof() {
        let start = r.p;
        let (id, sz) = match elem(&mut r) {
            Ok(x) => x,
            Err(_) => break,
        };
        let end = match sz {
            Some(s) => (r.p + s as usize).min(payload.len()),
            None => payload.len(),
        };
        if id == 0xBB {
            if let Ok(v) = parse_cue_point(&payload[r.p..end], timecode_scale) {
                pts.push(v);
            }
        }
        r.p = if end <= start { start + 1 } else { end };
    }
    pts.sort();
    pts.dedup();
    for (t, tr, cp) in pts {
        use js_sys::{Object, Reflect};
        let o = Object::new();
        Reflect::set(&o, &"timeNs".into(), &JsValue::from_f64(t as f64))?;
        Reflect::set(&o, &"track".into(), &JsValue::from_f64(tr as f64))?;
        Reflect::set(&o, &"clusterPos".into(), &JsValue::from_f64(cp as f64))?;
        out.push(&o);
    }
    Ok(out)
}

fn parse_cue_point(buf: &[u8], scale: u64) -> Result<(i64, u64, u64), String> {
    let mut r = R::new(buf);
    let mut time_ns: Option<i64> = None;
    let mut track = 0u64;
    let mut cpos = 0u64;
    while !r.eof() {
        let s = r.p;
        let (id, sz) = elem(&mut r)?;
        let end = match sz {
            Some(x) => (r.p + x as usize).min(buf.len()),
            None => buf.len(),
        };
        if id == 0xB3 {
            time_ns = Some(ticks_to_ns(r.uint(end - r.p)? as i64, scale));
        } else if id == 0xB7 {
            // CueTrackPositions : enfants relatifs à CETTE tranche.
            let slice = &buf[r.p..end];
            let mut tr = R::new(slice);
            while !tr.eof() {
                let ts = tr.p;
                let (tid, tsz) = match elem(&mut tr) {
                    Ok(x) => x,
                    Err(_) => break,
                };
                let tend = match tsz {
                    Some(x) => (tr.p + x as usize).min(slice.len()),
                    None => slice.len(),
                };
                let tn = tend.saturating_sub(tr.p);
                if tid == 0xF7 {
                    track = tr.uint(tn)?;
                } else if tid == 0xF1 {
                    cpos = tr.uint(tn)?;
                } else {
                    tr.skip(tn)?;
                }
                tr.p = if tend <= ts { ts + 1 } else { tend };
            }
        }
        r.p = if end <= s { s + 1 } else { end };
    }
    time_ns.map(|t| (t, track, cpos)).ok_or("cue sans temps".into())
}

