import { ConfidentialClientApplication } from '@azure/msal-node';

// Réutilise l'App Registration déjà utilisée pour l'accès Graph (OneDrive/SharePoint) en app-only.
// Authority "organizations" (et non le tenant ESPL spécifique) : l'app doit être configurée en
// multi-tenant dans Azure Portal > Authentification pour que des comptes professionnels/scolaires
// d'autres tenants (ex: groupe-eduservices.fr) puissent atteindre l'écran de connexion. Le filtrage
// des domaines autorisés est ensuite fait par notre propre code (STUDENT_EMAIL_DOMAINS / COLLABORATOR_EMAIL_DOMAINS).
const msalClient = new ConfidentialClientApplication({
    auth: {
        clientId: process.env.MICROSOFT_APP_ID,
        authority: 'https://login.microsoftonline.com/organizations',
        clientSecret: process.env.MICROSOFT_APP_PASSWORD,
    },
});

const SCOPES = ['User.Read'];

export function getAuthCodeUrl(state) {
    return msalClient.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri: process.env.SSO_REDIRECT_URI,
        state,
    });
}

export function acquireTokenByCode(code) {
    return msalClient.acquireTokenByCode({
        code,
        scopes: SCOPES,
        redirectUri: process.env.SSO_REDIRECT_URI,
    });
}

export function getLogoutUrl(postLogoutRedirectUri) {
    return `https://login.microsoftonline.com/organizations/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`;
}
