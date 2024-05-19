import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { getFirestore, provideFirestore, connectFirestoreEmulator } from '@angular/fire/firestore';
import { getFunctions, provideFunctions, connectFunctionsEmulator } from '@angular/fire/functions';
import { getMessaging, provideMessaging } from '@angular/fire/messaging';
import { firebaseConfig } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes), 
    provideFirebaseApp(() => initializeApp(firebaseConfig)), 
    provideFirestore(() => {
      const  firestore = getFirestore();
      if (location.hostname === 'localhost') {
        connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
      }
      return  firestore;
    }), 
    provideFunctions(() => {
      const  functions = getFunctions();
      if (location.hostname === 'localhost') {
        connectFunctionsEmulator(functions, '127.0.0.1', 5001);
      }
      return  functions;
    }), 
    provideMessaging(() => getMessaging())
  ]
};
