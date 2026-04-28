import 'dotenv/config';
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

function createClient() {
    const credential = new ClientSecretCredential(
        process.env.MICROSOFT_APP_TENANT_ID,
        process.env.MICROSOFT_APP_ID,
        process.env.MICROSOFT_APP_PASSWORD
    );
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
        scopes: ['https://graph.microsoft.com/.default']
    });
    return Client.initWithMiddleware({ authProvider });
}

const client = createClient();

console.log('=== Recherche du site ESPLDrive ===\n');

// Methode 1 : search avec des termes variés
const terms = ['ESPL', 'Drive', 'Numerique', 'Projets'];
for (const t of terms) {
    try {
        const r = await client.api(`/sites?search=${t}`).select('id,displayName,webUrl').get();
        if (r.value.length > 0) {
            console.log(`Résultats pour search="${t}" :`);
            r.value.forEach(s => console.log(`  ${s.displayName} (${s.webUrl})  ->  ${s.id}`));
        } else {
            console.log(`search="${t}" : 0 résultat`);
        }
    } catch (e) {
        console.log(`search="${t}" : ${e.message}`);
    }
}

// Methode 2 : site racine de campusespl
console.log('\n=== Site racine campusespl ===');
try {
    const root = await client.api('/sites/campusespl.sharepoint.com').select('id,displayName,webUrl').get();
    console.log(`Site racine : ${root.displayName} (${root.webUrl})  ->  ${root.id}`);
} catch (e) {
    console.log('site racine : ' + e.message);
}

// Methode 3 : tenter d'acceder au site ESPLDrive via son GUID connu
// (depuis votre .env original : c9cd8b9b-8c4c-4aa9-a6cd-1d2b014771ad)
// Certains tenants avec domaine vanity enregistrent le site sous "root" + siteGuid
console.log('\n=== Tentative via GUID direct ===');
const siteGuid = 'c9cd8b9b-8c4c-4aa9-a6cd-1d2b014771ad';
try {
    const r = await client.api(`/sites/${siteGuid}`).select('id,displayName,webUrl').get();
    console.log(`TROUVÉ : ${r.displayName} -> ${r.id}`);
} catch (e) {
    console.log('GUID direct : ' + e.message);
}

// Methode 4 : GUID complet avec host vanity encode
console.log('\n=== via siteCollection hostname eduservices ===');
// Le domaine vanity est souvent enregistre comme alias du tenant principal
// On peut tenter l'appel direct si la region Graph le redirige
try {
    const r = await client.api('/sites/root').select('id,displayName,webUrl,siteCollection').get();
    console.log('Root: ' + JSON.stringify(r.siteCollection));
} catch (e) {
    console.log('root: ' + e.message);
}
