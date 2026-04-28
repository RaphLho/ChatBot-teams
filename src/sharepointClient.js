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
        let response;
        try {
            response = await client
                .api(`/users/${userEmail}/drive/root:/${currentPath}:/children`)
                .select('id,name,file,folder,size,lastModifiedDateTime,@microsoft.graph.downloadUrl')
                .get();
        } catch (err) {
            console.error(`❌ Impossible de lister "${currentPath}" : ${err.message}`);
            return;
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
    }

    await scanFolder(folderPath);
    return allFiles;
}

async function downloadFileBuffer(downloadUrl) {
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status} — ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
}

export async function fetchSharePointDocuments() {
    const userEmail = process.env.ONEDRIVE_USER_EMAIL;
    const folderPath = process.env.ONEDRIVE_FOLDER_PATH;

    if (!userEmail || !folderPath) {
        throw new Error('Variables ONEDRIVE_USER_EMAIL et ONEDRIVE_FOLDER_PATH manquantes dans .env');
    }

    console.log(`🔌 Connexion au OneDrive de ${userEmail} via Microsoft Graph...`);
    const client = createGraphClient();

    console.log(`📂 Scan du dossier : ${folderPath}`);
    const files = await listFilesRecursive(client, userEmail, folderPath);
    console.log(`📋 ${files.length} fichier(s) compatible(s) trouvé(s)`);

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
