import 'dotenv/config';
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

const SUPPORTED_EXTENSIONS = [
    '.pdf', '.md', '.txt', '.json', '.xml', '.csv',
    '.docx', '.xlsx', '.xls', '.texte'
];

function createGraphClient() {
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

async function listFilesRecursive(client, userEmail, folderPath) {
    const allFiles = [];

    async function scanFolder(currentPath) {
        // Graph pagine /children (200 éléments par page) : il faut suivre @odata.nextLink jusqu'au
        // bout. Une page manquante donnerait une liste incomplète, donc la suppression des
        // documents correspondants dans la base RAG.
        let nextUrl = `/users/${userEmail}/drive/root:/${currentPath}:/children`;

        while (nextUrl) {
            let response;
            try {
                response = await client.api(nextUrl).get();
            } catch (err) {
                // On propage volontairement l'erreur au lieu de renvoyer une liste partielle : la
                // liste retournée fait autorité pour purger la base RAG (tout fichier absent est
                // supprimé). Un sous-dossier illisible produirait sinon la suppression silencieuse
                // de tous ses documents sur un simple incident réseau.
                console.error(`❌ Impossible de lister "${currentPath}" : ${err.message}`);
                throw new Error(`Listing OneDrive incomplet sur "${currentPath}" : ${err.message}`);
            }

            for (const item of response.value) {
                if (item.folder) {
                    await scanFolder(`${currentPath}/${item.name}`);
                } else if (item.file) {
                    const ext = item.name.includes('.')
                        ? item.name.substring(item.name.lastIndexOf('.')).toLowerCase()
                        : '';
                    if (SUPPORTED_EXTENSIONS.includes(ext)) {
                        allFiles.push({
                            name: item.name,
                            fullPath: `${currentPath}/${item.name}`,
                            downloadUrl: item['@microsoft.graph.downloadUrl'],
                            ext,
                            size: item.size || 0,
                            lastModified: item.lastModifiedDateTime
                        });
                    }
                }
            }

            nextUrl = response['@odata.nextLink'] || null;
        }
    }

    await scanFolder(folderPath);
    return allFiles;
}

async function downloadFileBuffer(downloadUrl) {
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status} — ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
}

export async function listOneDriveFiles() {
    const userEmail = process.env.ONEDRIVE_USER_EMAIL;
    const folderPath = process.env.ONEDRIVE_FOLDER_PATH;

    if (!userEmail || !folderPath) {
        throw new Error('Variables ONEDRIVE_USER_EMAIL et ONEDRIVE_FOLDER_PATH manquantes dans .env');
    }

    console.log(`🔌 Connexion au OneDrive de ${userEmail}...`);
    const client = createGraphClient();

    console.log(`📂 Scan du dossier : ${folderPath}`);
    const files = await listFilesRecursive(client, userEmail, folderPath);
    console.log(`📋 ${files.length} fichier(s) compatible(s) trouvé(s)`);
    return files;
}

// Récupère l'URL web (webUrl) du dossier OneDrive indexé, pour un lien "Ouvrir dans OneDrive"
// depuis la page de statistiques.
export async function getOneDriveFolderUrl() {
    const userEmail = process.env.ONEDRIVE_USER_EMAIL;
    const folderPath = process.env.ONEDRIVE_FOLDER_PATH;

    if (!userEmail || !folderPath) {
        throw new Error('Variables ONEDRIVE_USER_EMAIL et ONEDRIVE_FOLDER_PATH manquantes dans .env');
    }

    const client = createGraphClient();
    const item = await client
        .api(`/users/${userEmail}/drive/root:/${folderPath}`)
        .get();
    return item.webUrl;
}

export async function downloadFilesBuffers(files) {
    const documents = [];
    for (const file of files) {
        const sizeKb = Math.round(file.size / 1024);
        console.log(`⬇️  Téléchargement : ${file.name} (${sizeKb} Ko)`);
        try {
            const buffer = await downloadFileBuffer(file.downloadUrl);
            documents.push({ name: file.name, fullPath: file.fullPath, buffer, ext: file.ext });
        } catch (err) {
            console.error(`   ❌ Erreur téléchargement "${file.name}" : ${err.message}`);
        }
    }
    return documents;
}
