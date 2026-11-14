import { ACCENTS, DENSITIES, TEXT_SIZES, THEMES } from "../../../shared/api.ts";
import { useAppearance } from "../appearance.tsx";
import { Loading } from "../ui.tsx";

const label = (value: string) => value[0].toUpperCase() + value.slice(1);
export function AppearancePanel() {
	const { appearance, ready, saving, error, update } = useAppearance();
	return <div className="stack appearance-settings">
		<div className="panel-heading"><div><h2>Appearance</h2><p>Make this workspace feel like yours. Changes apply instantly.</p></div></div>
		{!ready && !error && <Loading />}
		<fieldset disabled={!ready}><legend>Theme</legend><div className="appearance-options theme-options">{THEMES.map(theme => <button key={theme} type="button" aria-pressed={appearance.theme === theme} onClick={() => update({ theme })}><span className={`theme-preview ${theme}`} aria-hidden="true"><span /><span /></span>{label(theme)}</button>)}</div><p className="hint">System follows your device’s light or dark appearance.</p></fieldset>
		<fieldset disabled={!ready}><legend>Accent</legend><div className="accent-options">{ACCENTS.map(accent => <button key={accent} type="button" data-swatch={accent} aria-label={`${label(accent)} accent`} aria-pressed={appearance.accent === accent} onClick={() => update({ accent })}><span className="accent-swatch" aria-hidden="true">{appearance.accent === accent ? "✓" : ""}</span><span>{label(accent)}</span></button>)}</div></fieldset>
		<fieldset disabled={!ready}><legend>Text size</legend><div className="appearance-options">{TEXT_SIZES.map(textSize => <button key={textSize} type="button" aria-pressed={appearance.textSize === textSize} onClick={() => update({ textSize })}>{label(textSize)}</button>)}</div></fieldset>
		<fieldset disabled={!ready}><legend>Density</legend><div className="appearance-options">{DENSITIES.map(density => <button key={density} type="button" aria-pressed={appearance.density === density} onClick={() => update({ density })}>{label(density)}</button>)}</div><p className="hint">Compact reduces spacing in cards and conversations.</p></fieldset>
		<div className="appearance-status hint" role="status">{saving ? "Saving appearance…" : ready && !error ? "Saved to this hub · shared by browser and desktop" : ""}</div>
		{error && <p className="error-box" role="alert">{error}</p>}
	</div>;
}
