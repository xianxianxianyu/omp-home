import { ACCENTS, DENSITIES, LANGUAGE_SETTINGS, TEXT_SIZES, THEMES } from "../../../shared/api.ts";
import { useAppearance } from "../appearance.tsx";
import { useI18n, useT } from "../i18n/index.tsx";
import { Loading } from "../ui.tsx";

export function AppearancePanel() {
	const t = useT().panels.appearance;
	const language = useI18n();
	const { appearance, ready, saving, error, update } = useAppearance();
	return <div className="stack appearance-settings">
		<div className="panel-heading"><div><h2>{t.title}</h2><p>{t.description}</p></div></div>
		<fieldset disabled={!language.ready}><legend>{t.language}</legend><div className="appearance-options">{LANGUAGE_SETTINGS.map(setting => <button key={setting} type="button" data-language={setting} aria-pressed={language.setting === setting} onClick={() => { void language.update(setting); }}>{t.languages[setting]}</button>)}</div><p className="hint">{t.languageHint}</p></fieldset>
		<div className="language-status hint" role="status">{language.saving ? t.savingLanguage : ""}</div>
		{language.error && <p className="error-box" role="alert">{language.error}</p>}
		{!ready && !error && <Loading />}
		<fieldset disabled={!ready}><legend>{t.theme}</legend><div className="appearance-options theme-options">{THEMES.map(theme => <button key={theme} type="button" data-theme={theme} aria-pressed={appearance.theme === theme} onClick={() => update({ theme })}><span className={`theme-preview ${theme}`} aria-hidden="true"><span /><span /></span>{t.themes[theme]}</button>)}</div><p className="hint">{t.themeHint}</p></fieldset>
		<fieldset disabled={!ready}><legend>{t.accent}</legend><div className="accent-options">{ACCENTS.map(accent => <button key={accent} type="button" data-swatch={accent} aria-label={t.accentLabel(t.accents[accent])} aria-pressed={appearance.accent === accent} onClick={() => update({ accent })}><span className="accent-swatch" aria-hidden="true">{appearance.accent === accent ? "✓" : ""}</span><span>{t.accents[accent]}</span></button>)}</div></fieldset>
		<fieldset disabled={!ready}><legend>{t.textSize}</legend><div className="appearance-options">{TEXT_SIZES.map(textSize => <button key={textSize} type="button" data-text-size={textSize} aria-pressed={appearance.textSize === textSize} onClick={() => update({ textSize })}>{t.textSizes[textSize]}</button>)}</div></fieldset>
		<fieldset disabled={!ready}><legend>{t.density}</legend><div className="appearance-options">{DENSITIES.map(density => <button key={density} type="button" data-density={density} aria-pressed={appearance.density === density} onClick={() => update({ density })}>{t.densities[density]}</button>)}</div><p className="hint">{t.densityHint}</p></fieldset>
		<div className="appearance-status hint" role="status">{saving ? t.saving : ""}</div>
		{error && <p className="error-box" role="alert">{error}</p>}
	</div>;
}
