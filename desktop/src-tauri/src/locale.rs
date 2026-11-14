//! Tray menu and update dialog text. The web UI owns the language choice and reports it through
//! `set_language`; until the page has loaded, the macOS preferred language decides.

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang { En, Zh }

pub struct Strings {
    pub open: &'static str,
    pub check_updates: &'static str,
    pub quit: &'static str,
    pub up_to_date: &'static str,
    pub updates_title: &'static str,
    pub update_title: &'static str,
    pub update_available: fn(&str) -> String,
    pub install_and_restart: &'static str,
    pub later: &'static str,
    pub update_failed_title: &'static str,
    pub update_failed: fn(&str) -> String,
}

const EN: Strings = Strings {
    open: "Open omp-home",
    check_updates: "Check for updates…",
    quit: "Quit omp-home",
    up_to_date: "You’re running the latest version of omp-home.",
    updates_title: "omp-home updates",
    update_title: "Update omp-home",
    update_available: |version| format!("omp-home {version} is available. Install it and restart?"),
    install_and_restart: "Install and restart",
    later: "Later",
    update_failed_title: "Update failed",
    update_failed: |error| format!("Could not update omp-home.\n\n{error}"),
};

const ZH: Strings = Strings {
    open: "打开 omp-home",
    check_updates: "检查更新…",
    quit: "退出 omp-home",
    up_to_date: "omp-home 已是最新版本。",
    updates_title: "omp-home 更新",
    update_title: "更新 omp-home",
    update_available: |version| format!("omp-home {version} 已发布。现在安装并重启？"),
    install_and_restart: "安装并重启",
    later: "稍后",
    update_failed_title: "更新失败",
    update_failed: |error| format!("omp-home 未能更新。\n\n{error}"),
};

impl Lang {
    pub fn parse(tag: &str) -> Option<Lang> {
        let tag = tag.to_ascii_lowercase();
        if tag.starts_with("zh") { Some(Lang::Zh) } else if tag.starts_with("en") { Some(Lang::En) } else { None }
    }

    /// Mirrors `resolveLanguage` in shared/api.ts: the first zh* or en* preference wins, English otherwise.
    pub fn system() -> Lang {
        sys_locale::get_locales().find_map(|tag| Lang::parse(&tag)).unwrap_or(Lang::En)
    }

    pub fn strings(self) -> &'static Strings {
        match self { Lang::En => &EN, Lang::Zh => &ZH }
    }
}
