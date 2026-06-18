import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.scheidelholdings.castlehassle',
  appName: 'Castle Hassle',
  // Vite builds the game into www/ (see vite.config.ts). Capacitor copies that
  // into the iOS app on `npx cap sync ios`.
  webDir: 'www',
  server: {
    androidScheme: 'https',
  },
};

export default config;
