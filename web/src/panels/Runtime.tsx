import { useT } from "../i18n/index.tsx";
import { ResourcesSections } from "./Resources.tsx";
import { SessionsSection } from "./Sessions.tsx";

/** What the hub is running right now: diagnostics, not configuration. */
export function RuntimePanel() {
	const t = useT().panels.runtime;
	return (
		<div className="stack">
			<div className="panel-heading"><div><h2>{t.title}</h2><p className="muted">{t.description}</p></div></div>
			<SessionsSection />
			<ResourcesSections />
		</div>
	);
}
