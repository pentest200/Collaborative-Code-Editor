import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = {
  title: "Collaborative Code Editor",
  description: "Private project access for collaborative code editing"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
