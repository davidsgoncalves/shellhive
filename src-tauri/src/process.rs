use std::ffi::OsStr;
use std::process::Command;

/// A command for a background program. On Windows a console program started
/// by a windowed app opens a console window for as long as it runs; this one
/// starts without it.
pub fn background(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Kills a program with the processes it started. On Windows a program npm
/// installed runs under cmd.exe, and killing only that would leave it running.
pub fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let _ = background("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .status();
    }
    let _ = child.kill();
}
