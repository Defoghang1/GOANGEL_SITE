const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const email = 'goangelia@yahoo.com';
const password = '@#€_&-+()/';

async function createAdmin() {
  try {
    const user = await admin.auth().createUser({
      email: email,
      password: password,
      emailVerified: true
    });
    await admin.auth().setCustomUserClaims(user.uid, { admin: true });
    console.log('Compte admin créé avec succès :', user.uid);
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      console.log('Le compte existe déjà. Mise à jour du claim admin...');
      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().setCustomUserClaims(user.uid, { admin: true });
      console.log('Claim admin mis à jour pour :', user.uid);
    } else {
      console.error('Erreur :', error);
    }
  }
}

createAdmin();
