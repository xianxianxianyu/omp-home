import { useHub } from "./hub.tsx";
import { ResourcesPanel } from "./panels/Resources.tsx";
import { SessionsPanel } from "./panels/Sessions.tsx";
import { SettingsPanel } from "./panels/Settings.tsx";
import { WorkspacesPanel } from "./panels/Workspaces.tsx";
import { CopyButton, Loading, Modal, Section } from "./ui.tsx";
import "./settings-sheet.css";

const SECTIONS = [
	{ name: "General", Panel: SettingsPanel },
	{ name: "Workspaces", Panel: WorkspacesPanel },
	{ name: "Environment", Panel: ResourcesPanel },
	{ name: "Sessions", Panel: SessionsPanel },
	{ name: "About", Panel: AboutPanel },
] as const;

export function SettingsSheet() {
	const { settingsSection, openSettings, closeSettings } = useHub();
	if (settingsSection === null) return null;

	return (
		<Modal title="Settings" onClose={closeSettings} wide>
			<div className="settings-sheet">
				<nav className="settings-sheet-nav" aria-label="Settings sections">
					{SECTIONS.map(({ name }) => (
						<button type="button" key={name} aria-current={settingsSection === name ? "page" : undefined} onClick={() => openSettings(name)}>
							{name}
						</button>
					))}
				</nav>
				<div className="settings-sheet-content" role="region" aria-label={`${settingsSection} settings`} tabIndex={0}>
					{SECTIONS.map(({ name, Panel }) => settingsSection === name ? <Panel key={name} /> : null)}
				</div>
			</div>
		</Modal>
	);
}

function AboutPanel() {
	const { state } = useHub();
	if (!state) return <Loading />;

	const homePath = state.setup.homePath;
	return (
		<div className="stack">
			<div className="panel-heading"><div><h2>About</h2><p className="muted">omp-home {state.version}</p></div></div>
			<Section title="omp runtime">
				<div className="card">
					<h3>omp {state.omp.version ?? "not detected"}</h3>
					<p className="muted">{state.omp.managed ? "Managed runtime" : "User-provided runtime"}</p>
					<code className="prewrap">{state.omp.path ?? "No executable found"}</code>
					{state.omp.warning && <p className="error-text" role="alert">{state.omp.warning}</p>}
				</div>
			</Section>
			<Section title="Local installation">
				<div className="card">
					<div className="muted">Home path</div>
					<div className="row">
						<code className="prewrap grow">{homePath ?? "Not configured"}</code>
						{homePath && <CopyButton text={homePath} />}
					</div>
					<p className="hint">The home path is fixed during setup and cannot be changed here.</p>
					<div className="muted">Hub URL</div>
					<code className="prewrap">{window.location.origin}</code>
				</div>
			</Section>
		</div>
	);
}
