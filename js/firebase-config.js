import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCiZJGs0MASvP9mLp3HIA9omjuERs5Dc-A",
  authDomain: "goangel-1fc0b.firebaseapp.com",
  projectId: "goangel-1fc0b",
  storageBucket: "goangel-1fc0b.firebasestorage.app",
  messagingSenderId: "91423026821",
  appId: "1:91423026821:web:8f6267f34ea3fd8cae83ec"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
