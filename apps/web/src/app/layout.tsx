import type { ReactNode } from "react";
import "./styles.css";

export const metadata = {
  title: "OperatorBoard",
  description: "Human-governed control plane for AI agents."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
