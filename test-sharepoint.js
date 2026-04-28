// Test de connexion OneDrive via Microsoft Graph API
// Exécuter : node test-sharepoint.js
import 'dotenv/config';
import { fetchSharePointDocuments } from './src/sharepointClient.js';

console.log('🧪 Test de connexion OneDrive...\n');
console.log(`   Utilisateur : ${process.env.ONEDRIVE_USER_EMAIL}`);
console.log(`   Dossier     : ${process.env.ONEDRIVE_FOLDER_PATH}\n`);

try {
    const docs = await fetchSharePointDocuments();
    console.log(`\n✅ Succès ! ${docs.length} document(s) récupéré(s) :\n`);
    docs.forEach(d => {
        const sizeKb = Math.round(d.buffer.length / 1024);
        console.log(`  📄 ${d.name}  (${d.ext}, ${sizeKb} Ko)`);
    });
} catch (err) {
    console.error('\n❌ Échec :', err.message);
    if (err.message.includes('401')) {
        console.error('→ Vérifiez MICROSOFT_APP_ID / PASSWORD / TENANT_ID dans .env');
    } else if (err.message.includes('403')) {
        console.error('→ Ajoutez Files.Read.All aux permissions de l\'app sur portal.azure.com');
    } else if (err.message.includes('404')) {
        console.error('→ Vérifiez ONEDRIVE_USER_EMAIL et ONEDRIVE_FOLDER_PATH');
    }
}
