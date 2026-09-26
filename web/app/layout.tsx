import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Header } from '@/components/header';
import { LiveProvider } from '@/lib/live';
import { SettingsProvider } from '@/lib/scope';
import './globals.css';

export const metadata: Metadata = {
  title: 'JOB-BOT',
  description: 'Local control panel for the Naukri job bot',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <LiveProvider>
          <SettingsProvider>
            <Header />
            <main className="mx-auto max-w-6xl px-4 py-4">{children}</main>
          </SettingsProvider>
        </LiveProvider>
      </body>
    </html>
  );
}
