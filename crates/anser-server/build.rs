use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=ANSER_REQUIRE_WEB");
    let source = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../clients/web/dist");
    println!("cargo:rerun-if-changed={}", source.display());
    let source = match source.canonicalize() {
        Ok(source) if source.join("index.html").is_file() => Some(source),
        _ => None,
    };
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    let require_web = std::env::var("ANSER_REQUIRE_WEB").as_deref() == Ok("1");
    assert!(
        source.is_some() || !(release || require_web),
        "build clients/web before packaging Anser"
    );
    let mut generated =
        "fn website(path: &str) -> Option<&'static [u8]> { match path {\n".to_owned();
    if let Some(source) = source {
        collect(&source, &source, &mut generated);
    }
    generated.push_str("_ => None, } }\n");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    fs::write(out.join("embedded_web.rs"), generated).unwrap();
}

fn collect(root: &Path, directory: &Path, output: &mut String) {
    let mut files: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    files.sort_by_key(|entry| entry.file_name());
    for entry in files {
        let path = entry.path();
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            collect(root, &path, output);
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            writeln!(
                output,
                "{relative:?} => Some(include_bytes!({:?})),",
                path.to_str().unwrap()
            )
            .unwrap();
        } else {
            panic!("frontend output must consist of regular files");
        }
    }
}
