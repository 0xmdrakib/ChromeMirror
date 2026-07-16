import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./design-system.css";

const themeScript = `
  try {
    var savedTheme = window.localStorage.getItem("chrome-mirror-theme");
    document.documentElement.dataset.theme = savedTheme === "dark" ? "dark" : "light";
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
`;

const interfaceFont = Inter({
  variable: "--font-interface",
  subsets: ["latin"],
});

const codeFont = JetBrains_Mono({
  variable: "--font-code",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Chrome Mirror",
    template: "%s | Chrome Mirror",
  },
  description: "Chrome Mirror hosted access, licenses, devices, and billing.",
  icons: {
    icon: { url: "/brand-icon.png", type: "image/png", sizes: "256x256" },
    shortcut: "/brand-icon.png",
    apple: "/brand-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${interfaceFont.variable} ${codeFont.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
