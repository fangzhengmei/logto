const account_center = {
  title: 'CENTRE DE COMPTE',
  description: 'Personnalisez les parcours de votre centre de compte à l’aide des API Logto.',
  enable_account_api: 'Activer le centre de compte et l’API Account',
  enable_account_api_description:
    'Active à la fois l’API Account destinée aux utilisateurs finaux et le centre de compte prêt à l’emploi de Logto. Lorsqu’elle est désactivée, ces deux fonctionnalités ne sont pas disponibles.',
  field_options: {
    off: 'Désactivé',
    edit: 'Modifier',
    read_only: 'Lecture seule',
    enabled: 'Activé',
    disabled: 'Désactivé',
  },
  sections: {
    account_security: {
      title: 'SÉCURITÉ DU COMPTE',
      description:
        "Gérez l'accès à l'API Account afin de permettre aux utilisateurs, après leur connexion à l'application, d'afficher ou de modifier leurs informations d'identité et leurs facteurs d'authentification.",
      security_verification: {
        title: 'Vérification de sécurité',
        description:
          "Avant de modifier les paramètres de sécurité, les utilisateurs doivent vérifier leur identité pour obtenir un identifiant d'enregistrement de vérification valable 10 minutes. Pour activer une méthode de vérification (e-mail, téléphone, mot de passe), définissez l'autorisation de l'API Account ci-dessous sur <strong>Lecture seule</strong> (minimum) ou <strong>Modifier</strong> afin que le système puisse détecter si l'utilisateur l'a configurée. <a>En savoir plus</a>",
      },
      groups: {
        identifiers: {
          title: 'Identifiants',
        },
        authentication_factors: {
          title: 'Facteurs d’authentification',
        },
        session_management: {
          title: 'Gestion des sessions',
        },
      },
    },
    user_profile: {
      title: 'PROFIL UTILISATEUR',
      description:
        'Gérez l’accès à l’API Account afin de permettre aux utilisateurs d’afficher ou de modifier leurs données de profil de base ou personnalisées après leur connexion à l’application.',
      groups: {
        profile_data: {
          title: 'Données du profil',
        },
      },
    },
    secret_vault: {
      title: 'COFFRE SECRET',
      description:
        'Pour les connecteurs sociaux et d’entreprise, stockez en toute sécurité les jetons d’accès de tiers pour appeler leurs API (par exemple ajouter des événements au Google Agenda).',
      third_party_token_storage: {
        title: 'Jeton tiers',
        third_party_access_token_retrieval: 'Récupération de jeton d’accès tiers',
        third_party_token_tooltip:
          'Pour stocker des jetons, activez cette option dans la configuration du connecteur social ou d’entreprise concerné.',
        third_party_token_description:
          'Une fois l’API Account activée, la récupération des jetons tiers est automatiquement activée.',
      },
    },
  },
  fields: {
    email: 'Adresse e-mail',
    phone: 'Numéro de téléphone',
    social: 'Identités sociales',
    password: 'Mot de passe',
    mfa: 'Authentification multifacteur',
    mfa_description:
      'Permettez aux utilisateurs de gérer leurs méthodes MFA depuis le centre de compte.',
    username: "Nom d'utilisateur",
    name: 'Nom',
    avatar: 'Avatar',
    profile: 'Profil',
    profile_description: 'Contrôlez l’accès aux attributs structurés du profil.',
    custom_data: 'Données personnalisées',
    custom_data_description:
      'Contrôlez l’accès aux données JSON personnalisées stockées sur l’utilisateur.',
    sessions: 'Sessions',
  },
  profile_fields: {
    title: 'Champs de profil pour le centre de compte prédéfini',
    add_profile_fields: 'Ajouter des champs de profil',
    hint: {
      not_in_list: 'Pas dans la liste ?',
      set_up: 'Configurer',
      go_to: "d'autres champs de profil maintenant.",
    },
    disabled_hint: {
      name: "Pour ajouter ce champ, définissez d'abord l'autorisation « Nom » sur « Modifier/Lecture seule » dans Données de profil ci-dessus.",
      avatar:
        "Pour ajouter ce champ, définissez d'abord l'autorisation « Avatar » sur « Modifier/Lecture seule » dans Données de profil ci-dessus.",
      profile:
        "Pour ajouter ce champ, définissez d'abord l'autorisation « Profil » sur « Modifier/Lecture seule » dans Données de profil ci-dessus.",
      custom_data:
        "Pour ajouter ce champ, définissez d'abord l'autorisation « Données personnalisées » sur « Modifier/Lecture seule » dans Données de profil ci-dessus.",
    },
  },
  webauthn_related_origins: 'Origines associées à WebAuthn',
  webauthn_related_origins_description:
    'Ajoutez les domaines de vos applications front-end autorisés à enregistrer des passkeys via l’API Account.',
  webauthn_related_origins_error: "L'origine doit commencer par https:// ou http://",
  delete_account_url: 'Supprimer le compte',
  delete_account_url_description:
    'Fournissez votre propre URL de point de terminaison pour gérer la suppression du compte avec une logique personnalisée.',
  prebuilt_ui: {
    title: "INTÉGRER L'INTERFACE UTILISATEUR PRÉCONSTRUITE",
    description:
      "Intégrez rapidement un centre de compte, une vérification de sécurité ou un flux de mise à jour de profil unique prêts à l'emploi avec une interface utilisateur préconstruite. Combinez simplement votre domaine avec le chemin pour former l'URL de votre centre de compte (par exemple, https://auth.foo.com/account/email).",
    permission_notice:
      "Pour intégrer ces flux préconstruits, définissez les autorisations de l'API de compte associées sur <strong>Modifier</strong> dans les paramètres ci-dessous.",
    account_center_title: "Intégrer le centre de compte prêt à l'emploi",
    account_center_description:
      "Dirigez les utilisateurs vers le centre de compte pour gérer les paramètres de sécurité tels que l'e-mail, le téléphone, le nom d'utilisateur, le mot de passe, la MFA et les comptes connectés.",
    flows_title: "Intégrer des flux de paramètres de sécurité prêts à l'emploi",
    single_task_flows_title: "Intégrer un flux de tâche unique prêt à l'emploi",
    flows_description:
      'Combinez votre domaine avec le chemin pour former votre URL de paramètres de compte (par exemple, https://auth.foo.com/account/email). Ajoutez éventuellement `redirect=` pour renvoyer les utilisateurs à votre application après une mise à jour réussie, `show_success=true` pour garder la page de succès visible, `ui_locales=` pour remplacer la langue par défaut, ou `identifier=` pour pré-remplir le champ de saisie de l’identifiant.',
    single_task_flows_description:
      "Dirigez les utilisateurs directement vers un flux spécifique (par exemple, la liaison d'email). Vous pouvez éventuellement ajouter `redirect=` pour renvoyer les utilisateurs à votre application après une mise à jour réussie, `show_success=true` pour garder la page de succès visible, `ui_locales=` pour remplacer la langue par défaut, ou `identifier=` pour pré-remplir le champ de saisie de l'identifiant.",
    tooltips: {
      email: 'Mettre à jour votre adresse e-mail principale',
      phone: 'Mettre à jour votre numéro de téléphone principal',
      username: "Mettre à jour votre nom d'utilisateur",
      password: 'Définir un nouveau mot de passe',
      social: 'Lier un compte social pour la connexion',
      social_change: 'Passer à un autre compte social lié',
      social_remove: 'Supprimer un compte social lié',
      authenticator_app:
        "Configurer une nouvelle application d'authentification pour l'authentification multifacteur",
      authenticator_app_replace: 'Replace your existing authenticator app with a new one',
      passkey_add: 'Enregistrer une nouvelle clé de passe',
      passkey_manage: 'Gérer vos clés de passe existantes ou en ajouter de nouvelles',
      backup_codes_generate: 'Générer un nouvel ensemble de 10 codes de sauvegarde',
      backup_codes_manage: 'Voir vos codes de sauvegarde disponibles ou en générer de nouveaux',
      account_center:
        "Accédez au centre de compte pour gérer les paramètres de sécurité tels que l'e-mail, le téléphone, le nom d'utilisateur, le mot de passe, la MFA et les comptes connectés",
      profile:
        'Le centre névralgique pour gérer vos informations personnelles (par exemple, nom, avatar)',
    },
    customize_note: "Vous ne voulez pas d'une expérience prête à l'emploi ? Vous pouvez pleinement",
    customize_link: "personnaliser vos flux avec l'API Account à la place.",
  },
  custom_css: {
    title: 'CSS personnalisé',
    description: "Personnalisez l'apparence du centre de compte en utilisant du CSS personnalisé.",
  },
};

export default Object.freeze(account_center);
