import { useState } from "react";
import { useHub } from "./hub.tsx";
import { RuntimePanel } from "./panels/Runtime.tsx";
import { SettingsPanel } from "./panels/Settings.tsx";
import { WorkspacesPanel } from "./panels/Workspaces.tsx";
import { ModelsPanel } from "./panels/Models.tsx";
import { AppearancePanel } from "./panels/Appearance.tsx";
import { CopyButton, Loading, Modal, Section } from "./ui.tsx";
import { useT } from "./i18n/index.tsx";
import "./settings-sheet.css";

const SECTIONS = [
	{ name: "General", Panel: SettingsPanel },
	{ name: "Models", Panel: ModelsPanel },
	{ name: "Appearance", Panel: AppearancePanel },
	{ name: "Workspaces", Panel: WorkspacesPanel },
	{ name: "Runtime", Panel: RuntimePanel },
	{ name: "About", Panel: AboutPanel },
] as const;

export function SettingsSheet() {
	const t = useT().shell;
	const { settingsSection, openSettings, closeSettings } = useHub();
	const [maximized, setMaximized] = useState(() => localStorage.getItem("omp-home-settings-maximized") === "true");
	if (settingsSection === null) return null;

	return (
		<Modal title={t.settings} onClose={closeSettings} wide className={`settings-dialog${maximized ? " maximized" : ""}`} headerActions={
			<button type="button" className="icon-button settings-maximize" aria-label={maximized ? t.restoreSettings : t.maximizeSettings} title={maximized ? t.restoreSettings : t.maximizeSettings} aria-pressed={maximized} onClick={() => {
				localStorage.setItem("omp-home-settings-maximized", String(!maximized));
				setMaximized(!maximized);
			}}>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
					{maximized ? <><path d="M5 3V1h10v10h-2" /><rect x="1" y="5" width="10" height="10" rx="1" /></> : <rect x="2" y="2" width="12" height="12" rx="1" />}
				</svg>
			</button>
		}>
			<div className="settings-sheet">
				<nav className="settings-sheet-nav" aria-label={t.preferences.sectionsLabel}>
					{SECTIONS.map(({ name }) => (
						<button type="button" key={name} aria-current={settingsSection === name ? "page" : undefined} onClick={() => openSettings(name)}>
							{t.preferences.sections[name]}
						</button>
					))}
				</nav>
				<div key={settingsSection} className="settings-sheet-content" role="region" aria-label={t.preferences.regionLabel(t.preferences.sections[settingsSection])} tabIndex={0}>
					{SECTIONS.map(({ name, Panel }) => settingsSection === name ? <Panel key={name} /> : null)}
				</div>
			</div>
		</Modal>
	);
}

function AboutPanel() {
	const t = useT().shell;
	const { state } = useHub();
	if (!state) return <Loading />;

	const homePath = state.setup.homePath;
	return (
		<div className="stack">
			<div className="panel-heading"><div><h2>{t.preferences.sections.About}</h2><p className="muted">omp-home {state.version}</p></div></div>
			<Section title={t.preferences.runtime}>
				<div className="card">
					<h3>omp {state.omp.version ?? t.preferences.notDetected}</h3>
					<p className="muted">{state.omp.managed ? t.preferences.managedRuntime : t.preferences.userRuntime}</p>
					<code className="prewrap">{state.omp.path ?? t.preferences.noExecutable}</code>
					{state.omp.warning && <p className="error-text" role="alert">{state.omp.warning}</p>}
				</div>
			</Section>
			<Section title={t.preferences.localInstallation}>
				<div className="card">
					<div className="muted">{t.preferences.homePath}</div>
					<div className="row">
						<code className="prewrap grow">{homePath ?? t.preferences.notConfigured}</code>
						{homePath && <CopyButton text={homePath} />}
					</div>
					<p className="hint">{t.preferences.homePathHint}</p>
					<div className="muted">{t.preferences.hubUrl}</div>
					<code className="prewrap">{window.location.origin}</code>
				</div>
			</Section>
		</div>
	);
}
