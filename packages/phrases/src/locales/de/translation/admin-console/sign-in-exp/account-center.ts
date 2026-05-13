const account_center = {
  title: 'KONTOZENTRUM',
  description: 'Passen Sie Ihre Kontozentrums-Workflows mit den Logto-APIs an.',
  enable_account_api: 'Kontozentrum und Account-API aktivieren',
  enable_account_api_description:
    'Aktiviert sowohl die benutzerseitige Account-API als auch das vorgefertigte Kontocenter von Logto. Wenn dies deaktiviert ist, sind beide Funktionen nicht verfügbar.',
  field_options: {
    off: 'Aus',
    edit: 'Bearbeiten',
    read_only: 'Nur lesen',
    enabled: 'Aktiviert',
    disabled: 'Deaktiviert',
  },
  sections: {
    account_security: {
      title: 'KONTO-SICHERHEIT',
      description:
        'Verwalten Sie den Zugriff auf die Account-API, damit Benutzer nach der Anmeldung Identitätsinformationen und Authentifizierungsfaktoren anzeigen oder bearbeiten können.',
      security_verification: {
        title: 'Sicherheitsüberprüfung',
        description:
          'Bevor Sicherheitseinstellungen geändert werden, müssen Benutzer ihre Identität verifizieren und eine 10 Minuten gültige Verifizierungs-ID erhalten. Um eine Verifizierungsmethode (E-Mail, Telefon, Passwort) zu aktivieren, setzen Sie die Account-API-Berechtigung unten auf <strong>Nur lesen</strong> (Minimum) oder <strong>Bearbeiten</strong>, damit das System erkennen kann, ob der Benutzer sie konfiguriert hat. <a>Mehr erfahren</a>',
      },
      groups: {
        identifiers: {
          title: 'Identifikatoren',
        },
        authentication_factors: {
          title: 'Authentifizierungsfaktoren',
        },
        session_management: {
          title: 'Sitzungsverwaltung',
        },
      },
    },
    user_profile: {
      title: 'BENUTZERPROFIL',
      description:
        'Verwalten Sie den Zugriff auf die Account-API, damit Benutzer nach der Anmeldung Basis- oder benutzerdefinierte Profildaten anzeigen oder bearbeiten können.',
      groups: {
        profile_data: {
          title: 'Profildaten',
        },
      },
    },
    secret_vault: {
      title: 'GEHEIMER TRESOR',
      description:
        'Speichern Sie für soziale und Enterprise-Konnektoren Drittanbieter-Zugriffstoken sicher, um deren APIs aufzurufen (z. B. Ereignisse zum Google Kalender hinzufügen).',
      third_party_token_storage: {
        title: 'Token von Drittanbietern',
        third_party_access_token_retrieval: 'Abruf von Drittanbieter-Zugriffstoken',
        third_party_token_tooltip:
          'Um Token zu speichern, können Sie diese Option in den Einstellungen des jeweiligen Social- oder Enterprise-Konnektors aktivieren.',
        third_party_token_description:
          'Sobald die Account-API aktiviert ist, wird der Abruf von Drittanbieter-Token automatisch freigeschaltet.',
      },
    },
  },
  fields: {
    email: 'E-Mail-Adresse',
    phone: 'Telefonnummer',
    social: 'Soziale Identitäten',
    password: 'Passwort',
    mfa: 'Multi-Faktor-Authentifizierung',
    mfa_description: 'Erlauben Sie Nutzern, ihre MFA-Methoden im Kontozentrum zu verwalten.',
    username: 'Benutzername',
    name: 'Name',
    avatar: 'Avatar',
    profile: 'Profil',
    profile_description: 'Steuern Sie den Zugriff auf strukturierte Profilattribute.',
    custom_data: 'Benutzerdefinierte Daten',
    custom_data_description:
      'Steuern Sie den Zugriff auf benutzerdefinierte JSON-Daten, die beim Benutzer gespeichert sind.',
    sessions: 'Sitzungen',
  },
  profile_fields: {
    title: 'Profilfelder für vorgefertigtes Konto-Center',
    add_profile_fields: 'Profilfelder hinzufügen',
    hint: {
      not_in_list: 'Nicht in der Liste?',
      set_up: 'Jetzt einrichten',
      go_to: 'andere Profilfelder.',
    },
    disabled_hint: {
      name: 'Um dieses Feld hinzuzufügen, setze zuerst die Berechtigung „Name“ im obigen Bereich „Profildaten“ auf „Bearbeiten/Nur lesen“.',
      avatar:
        'Um dieses Feld hinzuzufügen, setze zuerst die Berechtigung „Avatar“ im obigen Bereich „Profildaten“ auf „Bearbeiten/Nur lesen“.',
      profile:
        'Um dieses Feld hinzuzufügen, setze zuerst die Berechtigung „Profil“ im obigen Bereich „Profildaten“ auf „Bearbeiten/Nur lesen“.',
      custom_data:
        'Um dieses Feld hinzuzufügen, setze zuerst die Berechtigung „Benutzerdefinierte Daten“ im obigen Bereich „Profildaten“ auf „Bearbeiten/Nur lesen“.',
    },
  },
  webauthn_related_origins: 'WebAuthn-bezogene Ursprünge',
  webauthn_related_origins_description:
    'Fügen Sie die Domains Ihrer Frontend-Anwendungen hinzu, die über die Account-API Passkeys registrieren dürfen.',
  webauthn_related_origins_error: 'Der Ursprung muss mit https:// oder http:// beginnen',
  delete_account_url: 'Konto löschen',
  delete_account_url_description:
    'Geben Sie Ihre eigene Endpunkt-URL an, um die Kontolöschung mit benutzerdefinierter Logik zu verarbeiten.',
  prebuilt_ui: {
    title: 'INTEGRATE PREBUILT UI',
    description:
      'Integrieren Sie schnell vorgefertigte Kontocenter, Sicherheitsverifizierungen oder einzelne Profilaktualisierungsabläufe mit vorgefertigter Benutzeroberfläche. Kombinieren Sie einfach Ihre Domain mit der Route, um Ihre Kontocenter-URL zu bilden (z. B. https://auth.foo.com/account/email).',
    permission_notice:
      'Um diese vorgefertigten Flows zu integrieren, setzen Sie die entsprechenden Account-API-Berechtigungen in den Einstellungen unten auf <strong>Bearbeiten</strong>.',
    account_center_title: 'Vorgefertigtes Kontocenter integrieren',
    account_center_description:
      'Leiten Sie Benutzer zum Kontocenter, um Sicherheitseinstellungen wie E-Mail, Telefon, Benutzername, Passwort, MFA und verbundene Konten zu verwalten.',
    flows_title: 'Vorgefertigte Sicherheits-Einstellungen integrieren',
    single_task_flows_title: 'Vorgefertigten Einzelaufgaben-Ablauf integrieren',
    flows_description:
      'Kombinieren Sie Ihre Domain mit der Route, um Ihre Konto-Einstellungs-URL zu bilden (z. B. https://auth.foo.com/account/email). Optional können Sie `redirect=` hinzufügen, um Benutzer nach erfolgreicher Aktualisierung zurück zu Ihrer App zu leiten, `show_success=true`, um die Erfolgsseite sichtbar zu halten, `ui_locales=`, um die Standardsprache zu überschreiben, oder `identifier=`, um das Eingabefeld für den Bezeichner vorab auszufüllen.',
    single_task_flows_description:
      'Leiten Sie Benutzer direkt in einen bestimmten Ablauf (z. B. E-Mail-Verknüpfung). Optional können Sie `redirect=` hinzufügen, um Benutzer nach erfolgreicher Aktualisierung zurück zu Ihrer App zu leiten, `show_success=true`, um die Erfolgsseite sichtbar zu halten, `ui_locales=`, um die Standardsprache zu überschreiben, oder `identifier=`, um das Eingabefeld für den Bezeichner vorab auszufüllen.',
    tooltips: {
      email: 'Aktualisieren Sie Ihre primäre E-Mail-Adresse',
      phone: 'Aktualisieren Sie Ihre primäre Telefonnummer',
      username: 'Aktualisieren Sie Ihren Benutzernamen',
      password: 'Setzen Sie ein neues Passwort',
      social: 'Verknüpfen Sie ein Social-Konto für die Anmeldung',
      social_change: 'Zu einem anderen verknüpften Social-Konto wechseln',
      social_remove: 'Entfernen Sie ein verknüpftes Social-Konto',
      authenticator_app:
        'Richten Sie eine neue Authentifizierungs-App für die Multi-Faktor-Authentifizierung ein',
      authenticator_app_replace: 'Replace your existing authenticator app with a new one',
      passkey_add: 'Registrieren Sie einen neuen Sicherheitsschlüssel',
      passkey_manage:
        'Verwalten Sie Ihre vorhandenen Sicherheitsschlüssel oder fügen Sie neue hinzu',
      backup_codes_generate: 'Erstellen Sie ein neues Set von 10 Backup-Codes',
      backup_codes_manage:
        'Sehen Sie sich Ihre verfügbaren Backup-Codes an oder erstellen Sie neue',
      account_center:
        'Greifen Sie auf das Kontocenter zu, um Sicherheitseinstellungen wie E-Mail, Telefon, Benutzername, Passwort, MFA und verbundene Konten zu verwalten',
      profile:
        'Die zentrale Anlaufstelle zur Verwaltung Ihrer persönlichen Informationen (z. B. Name, Avatar)',
    },
    customize_note:
      'Möchten Sie nicht das vorgefertigte Erlebnis? Sie können mit der Account-API stattdessen vollständig',
    customize_link: 'Ihre Flows anpassen.',
  },
  custom_css: {
    title: 'CSS anpassen',
    description: 'Passen Sie das Erscheinungsbild des Kontocenters mit benutzerdefiniertem CSS an.',
  },
};

export default Object.freeze(account_center);
