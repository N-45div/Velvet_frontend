import type { Metadata } from "next";
import { Inter } from "next/font/google"; // Using Inter for clean, modern look.
import "./globals.css";
import { AppWalletProvider } from "../components/providers/WalletProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
    title: "VelvetRope | Private Lane for Solana",
    description: "Anti-MEV & Compliant Privacy Portal",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" className="dark">
            <body className={inter.className}>
                <AppWalletProvider>
                    {children}
                </AppWalletProvider>
            </body>
        </html>
    );
}
