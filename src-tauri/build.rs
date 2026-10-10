fn main() {
    // tauri-build 只跟踪 tauri.conf.json，不跟踪图标与 ../dist 的内容；
    // 不显式声明时改图标/只改前端都不会触发重编译。
    for icon in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    fn walk(dir: &std::path::Path) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path);
                } else if path.is_file() {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
    walk(std::path::Path::new("../dist"));

    tauri_build::build()
}
