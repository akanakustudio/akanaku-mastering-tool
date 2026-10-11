//! akdsp-cli: native entry point to the DSP engine (detailed design 5.1).
//! Subcommands (analyze, render, ...) are added as P0/P1 progresses.

fn main() {
    let arg = std::env::args().nth(1);
    match arg.as_deref() {
        Some("--version") | Some("-V") | None => println!("akdsp-cli {}", akdsp::ENGINE_VERSION),
        Some(other) => {
            eprintln!("unknown command: {other}");
            std::process::exit(2);
        }
    }
}
