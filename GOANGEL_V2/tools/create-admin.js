// Usage : ADMIN_EMAIL=vous@exemple.com ADMIN_PASSWORD='MotDePasseSolide' node tools/create-admin.js
// Nécessite serviceAccountKey.json à la racine (NE JAMAIS le publier : il est dans .gitignore).
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const serviceAccount = require('../serviceAccountKey.json');

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) { console.error('❌ Définissez ADMIN_EMAIL et ADMIN_PASSWORD.'); process.exit(1); }

initializeApp({ credential: cert(serviceAccount) });

(async () => {
  const auth = getAuth();
  try {
    const user = await auth.createUser({ email, password, emailVerified: true });
    await auth.setCustomUserClaims(user.uid, { admin: true });
    console.log('✅ Compte admin créé :', user.uid);
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      const user = await auth.getUserByEmail(email);
      await auth.setCustomUserClaims(user.uid, { admin: true });
      console.log('✅ Claim admin mis à jour pour :', user.uid);
    } else { console.error('❌ Erreur :', error); process.exit(1); }
  }
})();
