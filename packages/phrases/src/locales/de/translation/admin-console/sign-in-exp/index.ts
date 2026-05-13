import account_center from './account-center.js';
import content from './content.js';
import custom_profile_fields from './custom-profile-fields.js';
import sign_up_and_sign_in from './sign-up-and-sign-in.js';

const sign_in_exp = {
  page_title: 'Anmeldeoberfläche',
  page_title_with_account: 'Anmeldung & Konto',
  title: 'Anmeldung & Konto',
  description:
    'Passen Sie die Authentifizierungsabläufe und die Benutzeroberfläche an, und sehen Sie sich das Erlebnis sofort an.',
  tabs: {
    branding: 'Branding',
    sign_up_and_sign_in: 'Anmeldung und Registrierung',
    collect_user_profile: 'Benutzerprofil sammeln',
    account_center: 'Account Center',
    content: 'Inhalt',
    password_policy: 'Passwortrichtlinie',
  },
  welcome: {
    title: 'Anmeldungs-Erlebnis anpassen',
    description:
      'Setze schnell deine erste Anmeldung ein. Dieser Leitfaden führt dich durch alle notwendigen Einstellungen.',
    get_started: 'Erste Schritte',
    apply_remind:
      'Bitte beachte, dass die Anmeldeoberfläche für alle Anwendungen unter diesem Konto gilt.',
  },
  color: {
    title: 'FARBE',
    primary_color: 'Markenfarbe',
    dark_primary_color: 'Markenfarbe (Dunkler Modus)',
    dark_mode: 'Aktiviere Dunklen Modus',
    dark_mode_description:
      'Deine App erhält einen automatisch generierten Dunklen Modus, der auf deiner Markenfarbe und dem Logto-Algorithmus basiert. Du kannst diesen nach Belieben anpassen.',
    dark_mode_reset_tip: 'Neuberechnung der Farbe des dunklen Modus basierend auf der Markenfarbe.',
    reset: 'Neuberechnen',
  },
  branding: {
    title: 'BRANDING',
    ui_style: 'Stil',
    with_light: '{{value}}',
    with_dark: '{{value}} (dark)',
    app_logo_and_favicon: 'App-Logo und Favicon',
    company_logo_and_favicon: 'Firmenlogo und Favicon',
    organization_logo_and_favicon: 'Organisationslogo und Favicon',
    hide_logto_branding: 'Logto-Branding ausblenden',
    hide_logto_branding_description:
      'Entferne "Powered by Logto". Präsentiere deine Marke exklusiv mit einer klaren, professionellen Anmeldeerfahrung.',
    hide_logto_branding_oss_note: 'Diese Funktion ist nativ in <a>Logto Cloud</a> verfügbar.',
  },
  branding_uploads: {
    app_logo: {
      title: 'App-Logo',
      url: 'App-Logo URL',
      url_placeholder: 'https://your.cdn.domain/logo.png',
      error: 'App-Logo: {{error}}',
    },
    company_logo: {
      title: 'Firmenlogo',
      url: 'Firmenlogo URL',
      url_placeholder: 'https://your.cdn.domain/logo.png',
      error: 'Firmenlogo: {{error}}',
    },
    organization_logo: {
      title: 'Bild hochladen',
      url: 'Organisations-Logo URL',
      url_placeholder: 'https://your.cdn.domain/logo.png',
      error: 'Organisations-Logo: {{error}}',
    },
    connector_logo: {
      title: 'Bild hochladen',
      url: 'Konnektor-Logo URL',
      url_placeholder: 'https://your.cdn.domain/logo.png',
      error: 'Konnektor-Logo: {{error}}',
    },
    favicon: {
      title: 'Favicon',
      url: 'Favicon URL',
      url_placeholder: 'https://your.cdn.domain/favicon.ico',
      error: 'Favicon: {{error}}',
    },
  },
  custom_ui: {
    title: 'Benutzerdefinierte UI',
    cloud_tag: 'Cloud',
    css_code_editor_title: 'Benutzerdefiniertes CSS',
    css_code_editor_description1: 'Siehe das Beispiel für benutzerdefiniertes CSS.',
    css_code_editor_description2: '<a>{{link}}</a>',
    css_code_editor_description_link_content: 'Erfahre mehr',
    css_code_editor_content_placeholder:
      'Geben Sie Ihr benutzerdefiniertes CSS ein, um die Stile nach Ihren exakten Spezifikationen anzupassen. Drücken Sie Ihre Kreativität aus und heben Sie Ihre Benutzeroberfläche hervor.',
    bring_your_ui_title: 'Bringen Sie Ihr UI',
    bring_your_ui_description:
      'Laden Sie ein komprimiertes Paket (.zip) hoch, um die vorgefertigte Benutzeroberfläche von Logto durch Ihren eigenen Code zu ersetzen. <a>Erfahren Sie mehr</a>',
    bring_your_ui_oss_description: 'Passen Sie die Anmeldeoberfläche mit Ihrem eigenen Code an.',
    bring_your_ui_oss_card_description:
      'Laden Sie Ihre benutzerdefinierte Anmeldeoberfläche direkt in <a>Logto Cloud</a> hoch. Kein Fork und kein erneutes Deployment erforderlich.',
    bring_your_ui_oss_try_cloud: 'Cloud ausprobieren',
    preview_with_bring_your_ui_description:
      'Ihre benutzerdefinierten UI-Assets wurden erfolgreich hochgeladen und werden jetzt bereitgestellt. Daher wurde das eingebaute Vorschaufenster deaktiviert.\nUm Ihre personalisierte Anmelde-Benutzeroberfläche zu testen, klicken Sie auf die Schaltfläche "Live-Vorschau", um sie in einem neuen Browser-Tab zu öffnen.',
    csp_description:
      'Erlauben Sie zusätzliche Quellausdrücke für Ihre benutzerdefinierte Anmeldeoberfläche. Diese Werte werden nur angewendet, wenn benutzerdefinierte UI-Assets bereitgestellt werden.',
    csp_script_src: 'script-src-Quellen',
    csp_script_src_tip:
      'Erlauben Sie HTTPS-Quellausdrücke für Skripte, die von Ihrer benutzerdefinierten UI geladen werden, z. B. https://scripts.example.com oder https://*.example.com.',
    csp_connect_src: 'connect-src-Quellen',
    csp_connect_src_tip:
      'Erlauben Sie HTTPS- oder WSS-Quellausdrücke für Netzwerkanfragen Ihrer benutzerdefinierten UI, z. B. https://api.example.com oder wss://events.example.com.',
    csp_source_invalid_error:
      'Geben Sie einen gültigen Quellausdruck ein. Verwenden Sie https://-URLs; connect-src unterstützt auch wss://. CSP-Schlüsselwörter und Semikolons werden nicht unterstützt.',
    csp_source_duplicate_error: 'Dieser Quellausdruck ist bereits aufgeführt.',
  },
  account_center,
  sign_up_and_sign_in,
  content,
  setup_warning: {
    no_connector_sms:
      'Es wurde noch kein SMS-Konnektor eingerichtet. Bevor die Konfiguration abgeschlossen werden kann, können sich Benutzer nicht mit dieser Methode anmelden. <a>{{link}}</a> in "Verbindungen".',
    no_connector_email:
      'Es wurde noch kein E-Mail-Konnektor eingerichtet. Bevor die Konfiguration abgeschlossen werden kann, können sich Benutzer nicht mit dieser Methode anmelden. <a>{{link}}</a> in "Verbindungen".',
    no_connector_social:
      'Sie haben noch keine soziale Verbindung eingerichtet. Fügen Sie zuerst Verbindungen hinzu, um soziale Anmeldeverfahren anzuwenden. <a>{{link}}</a> in "Verbindungen".',
    no_connector_email_account_center:
      'Noch kein E-Mail-Konnektor eingerichtet. Richten Sie ihn unter <a>"E-Mail- und SMS-Konnektoren"</a> ein.',
    no_connector_sms_account_center:
      'Noch kein SMS-Konnektor eingerichtet. Richten Sie ihn unter <a>"E-Mail- und SMS-Konnektoren"</a> ein.',
    no_connector_social_account_center:
      'Noch kein Social-Konnektor eingerichtet. Richten Sie ihn unter <a>"Social-Konnektoren"</a> ein.',
    no_mfa_factor:
      'Es wurde noch kein MFA-Faktor eingerichtet. Richten Sie ihn in <a>{{link}}</a> ein.',
    setup_link: 'Einrichtung',
  },
  save_alert: {
    description:
      'Du implementierst neue Anmelde- und Registrierungsverfahren. Alle deine Benutzer können von der neuen Einrichtung betroffen sein. Bist du sicher, dass du die Änderung abschließen möchtest?',
    before: 'Vorher',
    after: 'Nachher',
    sign_up: 'Registrierung',
    sign_in: 'Anmeldung',
    social: 'Sozial',
    forgot_password_migration_notice:
      'Wir haben die Passwort-zurücksetzen-Verifizierung aktualisiert, um benutzerdefinierte Methoden zu unterstützen. Zuvor wurde dies automatisch durch Ihre E-Mail- und SMS-Konnektoren bestimmt. Klicken Sie auf <strong>Bestätigen</strong>, um das Upgrade abzuschließen.',
  },
  preview: {
    title: 'Vorschau',
    live_preview: 'Live-Vorschau',
    live_preview_tip: 'Speichern, um Änderungen anzuzeigen',
    native: 'Native',
    desktop_web: 'Desktop-Web',
    mobile_web: 'Mobile-Web',
    desktop: 'Desktop',
    mobile: 'Mobilgerät',
  },
  custom_profile_fields,
};

export default Object.freeze(sign_in_exp);
