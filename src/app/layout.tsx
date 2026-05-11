import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { AppWalletProvider } from "../components/providers/WalletProvider";

const spaceGrotesk = Space_Grotesk({
    subsets: ["latin"],
    variable: "--font-display",
});

const ibmPlexMono = IBM_Plex_Mono({
    subsets: ["latin"],
    weight: ["400", "500", "600"],
    variable: "--font-mono",
});

export const metadata: Metadata = {
    title: "VelvetMesh | Private Intents on Solana",
    description: "A privacy-first trading surface for devnet intents, live quotes, and protected settlement routes.",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body className={`${spaceGrotesk.variable} ${ibmPlexMono.variable}`}>
                <AppWalletProvider>
                    {children}
                </AppWalletProvider>
            </body>
        </html>
    );
}
