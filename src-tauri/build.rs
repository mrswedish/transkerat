fn main() {
    // Startas exe:n från en nätverksmapp (t.ex. ett skrivbord som omdirigerats till
    // \\server\...) läser Windows annars in programkoden från servern först när den behövs.
    // Ett kort nätverksavbrott mitt i en transkribering dödar då appen tyst (0xC0000006).
    // /SWAPRUN:NET kopierar hela exe:n till växlingsfilen vid start.
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os == "windows" {
        if let Ok(sdk) = std::env::var("VULKAN_SDK") {
            println!("cargo:rustc-link-search=native={sdk}/Lib");
        }
        if env == "msvc" {
            println!("cargo:rustc-link-arg-bins=/SWAPRUN:NET");
        }
    }
    tauri_build::build()
}
