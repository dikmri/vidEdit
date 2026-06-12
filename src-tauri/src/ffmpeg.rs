use std::path::PathBuf;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Find ffmpeg in PATH
pub fn find_ffmpeg() -> Option<PathBuf> {
    find_binary("ffmpeg")
}

/// Find ffprobe in PATH
pub fn find_ffprobe() -> Option<PathBuf> {
    find_binary("ffprobe")
}

fn find_binary(name: &str) -> Option<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![format!("{}.exe", name), name.to_string()]
    } else {
        vec![name.to_string()]
    };

    if let Ok(path_var) = std::env::var("PATH") {
        let separator = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(separator) {
            for candidate in &candidates {
                let full = PathBuf::from(dir).join(candidate);
                if full.exists() {
                    return Some(full);
                }
            }
        }
    }
    None
}

/// Get ffmpeg version string
pub fn get_ffmpeg_version() -> Option<String> {
    let ffmpeg = find_ffmpeg()?;
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.args(["-version"]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next()?;
    Some(first_line.to_string())
}

/// Build a Command for ffmpeg with CREATE_NO_WINDOW on Windows
pub fn ffmpeg_command() -> Option<std::process::Command> {
    let path = find_ffmpeg()?;
    let mut cmd = std::process::Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Some(cmd)
}

/// Build a Command for ffprobe with CREATE_NO_WINDOW on Windows
pub fn ffprobe_command() -> Option<std::process::Command> {
    let path = find_ffprobe()?;
    let mut cmd = std::process::Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Some(cmd)
}
