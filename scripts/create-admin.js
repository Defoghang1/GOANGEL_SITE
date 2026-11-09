const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount)
});

const email = 'goangelia@yahoo.com';
const password = '@#€_&-+()/';

async function createAdmin() {
  try {
    const auth = getAuth();
    const user = await auth.createUser({
      email: email,
      password: password,
      emailVerified: true
    });
    await auth.setCustomUserClaims(user.uid, { admin: true });
    console.log('✅ Compte admin créé avec succès :', user.uid);
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      console.log('ℹ️ Le compte existe déjà. Mise à jour du claim admin...');
      const auth = getAuth();
      const user = await auth.getUserByEmail(email);
      await auth.setCustomUserClaims(user.uid, { admin: true });
      console.log('✅ Claim admin mis à jour pour :', user.uid);
    } else {
      console.error('❌ Erreur :', error);
    }
  }
}

createAdmin();
