//! akdsp-cli: native entry point to the DSP engine (detailed design 5.1).
//!
//!   akdsp-cli --version
//!   akdsp-cli analyze <file>
//!   akdsp-cli master <in> <out.wav> [--cleanup 0..1] [--tone-match 0..1] [--tone -1..1] [--punch 0..1]
//!                    [--multiband 0|1] [--width 0..1.5] [--target LUFS] [--rate 44100|48000] [--bits 16|24]
use std::time::Instant;

use akdsp::analysis::{Analysis, analyze};
use akdsp::dsp::resample::resample;
use akdsp::io::{decode::decode, encode::encode_wav};
use akdsp::master::{ChainCache, MasterSettings, render};
use akdsp::{INTERNAL_SAMPLE_RATE, Stereo};

fn load(path: &str) -> (Stereo, u32) {
    let bytes = std::fs::read(path).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).map(str::to_lowercase);
    let d = decode(bytes, ext.as_deref()).unwrap_or_else(|e| fail(&e.to_string()));
    let audio = if d.sample_rate == INTERNAL_SAMPLE_RATE {
        d.audio
    } else {
        Stereo::new(resample(&d.audio.l, d.sample_rate, INTERNAL_SAMPLE_RATE), resample(&d.audio.r, d.sample_rate, INTERNAL_SAMPLE_RATE))
    };
    (audio, d.sample_rate)
}

fn print(label: &str, a: &Analysis) {
    println!("{label:>6}: {:6.2} LUFS  TP {:+5.2} dBTP  PLR {:5.2}  L95 {:6.2}  LRA {:4.1}", a.lufs, a.true_peak, a.plr, a.l95, a.lra);
}

fn fail(msg: &str) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("--version") | Some("-V") => println!("akdsp-cli {}", akdsp::ENGINE_VERSION),
        Some("analyze") => {
            let (x, _) = load(args.get(1).unwrap_or_else(|| fail("analyze <file>")));
            print("input", &analyze(&x, INTERNAL_SAMPLE_RATE));
        }
        Some("master") => {
            let (inp, out) = (
                args.get(1).unwrap_or_else(|| fail("master <in> <out.wav>")),
                args.get(2).unwrap_or_else(|| fail("master <in> <out.wav>")),
            );
            let mut s = MasterSettings::default();
            let (mut rate, mut bits) = (44_100u32, 24u16);
            let mut it = args[3..].iter();
            while let Some(flag) = it.next() {
                let v = it.next().unwrap_or_else(|| fail(&format!("{flag} needs a value")));
                let f: f32 = v.parse().unwrap_or_else(|_| fail(&format!("bad value {v}")));
                match flag.as_str() {
                    "--cleanup" => s.cleanup = f,
                    "--tone" => s.tone = f,
                    "--tone-match" => s.tone_match = f,
                    "--punch" => s.punch = f,
                    "--multiband" => s.multiband = f != 0.0,
                    "--width" => s.width = f,
                    "--target" => s.target_lufs = f,
                    "--rate" => rate = f as u32,
                    "--bits" => bits = f as u16,
                    _ => fail(&format!("unknown flag {flag}")),
                }
            }
            let t0 = Instant::now();
            let (x, _) = load(inp);
            let t_load = t0.elapsed();
            print("before", &analyze(&x, INTERNAL_SAMPLE_RATE));
            let t1 = Instant::now();
            let mut last = String::new();
            let r = render(&x, INTERNAL_SAMPLE_RATE, &s, &mut ChainCache::default(), &mut |stage, _| {
                if stage != last {
                    eprint!("[{stage} {:.1}s] ", t1.elapsed().as_secs_f32());
                    last = stage.to_string();
                }
                true
            })
            .expect("not cancelled");
            eprintln!();
            let t_render = t1.elapsed();
            print("after", &analyze(&r.audio, INTERNAL_SAMPLE_RATE));
            println!("report: {:?}", r.report);
            let t2 = Instant::now();
            let enc = encode_wav(&r.audio, INTERNAL_SAMPLE_RATE, rate, bits, s.ceiling_dbtp).unwrap_or_else(|e| fail(&e.to_string()));
            std::fs::write(out, &enc.bytes).unwrap_or_else(|e| fail(&e.to_string()));
            println!("export: {rate} Hz / {bits} bit, TP {:.2} dBTP -> {out}", enc.true_peak_dbtp);
            println!(
                "time: load {:.1}s, render {:.1}s, export {:.1}s",
                t_load.as_secs_f32(),
                t_render.as_secs_f32(),
                t2.elapsed().as_secs_f32()
            );
        }
        Some(other) => fail(&format!("unknown command: {other}")),
    }
}
