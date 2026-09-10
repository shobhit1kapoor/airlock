import "./globals.css";
export const metadata = { title: "Airlock", description: "Control what autonomous software can access." };
export default function Layout({children}:{children:React.ReactNode}) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://db.onlinewebfonts.com/c/8cb707a9b8a73f8a7403336b861c3074?family=BubbledotICG-FinePos"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
