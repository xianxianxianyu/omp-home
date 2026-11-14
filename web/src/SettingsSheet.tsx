import { useHub } from "./hub.tsx";
import { ResourcesPanel } from "./panels/Resources.tsx";
import { SessionsPanel } from "./panels/Sessions.tsx";
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
	{ name: "Environment", Panel: ResourcesPanel },
	{ name: "Sessions", Panel: SessionsPanel },
	{ name: "About", Panel: AboutPanel },
] as const;

export function SettingsSheet() {
	const t = useT().shell;
	const { settingsSection, openSettings, closeSettings } = useHub();
	if (settingsSection === null) return null;

	return (
		<Modal title={t.settings} onClose={closeSettings} wide>
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
