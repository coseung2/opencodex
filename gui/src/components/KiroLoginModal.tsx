import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/shared";

export interface KiroOrganizationLogin {
  startUrl: string;
  region: string;
}

type LoginKind = "personal" | "organization";

function canonicalStartUrl(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length > 2048
    || Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) return null;
  try {
    const url = new URL(trimmed);
    const authorityEnd = trimmed.indexOf("/", "https://".length);
    const authority = trimmed.slice("https://".length, authorityEnd === -1 ? undefined : authorityEnd);
    if (
      url.protocol !== "https:"
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.awsapps\.com$/i.test(url.hostname)
      || !/^\/start\/?$/.test(url.pathname)
      || url.search
      || url.hash
      || url.username
      || url.password
      || url.port
      || authority.includes(":")
    ) return null;
    return `https://${url.hostname.toLowerCase()}/start`;
  } catch {
    return null;
  }
}

export default function KiroLoginModal({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (organization?: KiroOrganizationLogin) => void;
}) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<LoginKind>("personal");
  const [startUrl, setStartUrl] = useState("");
  const [region, setRegion] = useState("");
  const [startUrlError, setStartUrlError] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const clearAndCancel = useCallback(() => {
    setKind("personal");
    setStartUrl("");
    setRegion("");
    setStartUrlError(false);
    onCancel();
  }, [onCancel]);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    clearAndCancel();
  }, [clearAndCancel]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (kind === "personal") {
      onSubmit();
      return;
    }
    const canonicalUrl = canonicalStartUrl(startUrl);
    if (!canonicalUrl) {
      setStartUrlError(true);
      return;
    }
    setStartUrlError(false);
    onSubmit({ startUrl: canonicalUrl, region: region.trim() });
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby={titleId}
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={clearAndCancel} />
      <form className="modal-card" style={{ maxWidth: 460 }} onSubmit={handleSubmit} onClick={event => event.stopPropagation()}>
        <div className="modal-head">
          <h3 id={titleId}>{t("kiroLogin.title")}</h3>
        </div>
        <p className="modal-desc">{t("kiroLogin.description")}</p>

        <div role="radiogroup" aria-label={t("kiroLogin.accountType")} style={{ display: "grid", gap: 8 }}>
          <label className="pwi-auth-state" style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input type="radio" name="kiro-login-kind" value="personal" checked={kind === "personal"} onChange={() => setKind("personal")} />
            <span>
              <strong style={{ display: "block" }}>{t("kiroLogin.personal")}</strong>
              <span className="muted text-label">{t("kiroLogin.personalDescription")}</span>
            </span>
          </label>
          <label className="pwi-auth-state" style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input type="radio" name="kiro-login-kind" value="organization" checked={kind === "organization"} onChange={() => setKind("organization")} />
            <span>
              <strong style={{ display: "block" }}>{t("kiroLogin.organization")}</strong>
              <span className="muted text-label">{t("kiroLogin.organizationDescription")}</span>
            </span>
          </label>
        </div>

        {kind === "organization" && (
          <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
            <label>
              <span className="field-label">{t("kiroLogin.startUrl")}</span>
              <input
                className="input"
                type="url"
                value={startUrl}
                required
                autoComplete="url"
                aria-invalid={startUrlError}
                aria-describedby={startUrlError ? "kiro-start-url-error" : undefined}
                placeholder={t("kiroLogin.startUrlPlaceholder")}
                onChange={event => { setStartUrl(event.target.value); setStartUrlError(false); }}
              />
              {startUrlError && <span id="kiro-start-url-error" className="text-label" style={{ color: "var(--red)" }}>{t("kiroLogin.startUrlInvalid")}</span>}
            </label>
            <label>
              <span className="field-label">{t("kiroLogin.region")}</span>
              <input
                className="input"
                value={region}
                required
                autoComplete="off"
                placeholder={t("kiroLogin.regionPlaceholder")}
                onChange={event => setRegion(event.target.value)}
              />
            </label>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={clearAndCancel}>{t("common.cancel")}</button>
          <button type="submit" className="btn btn-primary">{t("kiroLogin.continue")}</button>
        </div>
      </form>
    </dialog>
  );
}
