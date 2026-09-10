import "./globals.css";
export const metadata = { title: "Airlock", description: "Control what autonomous software can access." };
export default function Layout({children}:{children:React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
