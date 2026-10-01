export function NotConfigured() {
  return (
    <div className="min-h-screen grid place-items-center p-8">
      <div className="max-w-lg card p-8" data-testid="not-configured">
        <h1 className="text-xl font-semibold mb-2">This store is not connected to a project yet</h1>
        <p className="text-stone-600 text-sm leading-relaxed">
          Run the setup script against your project (<code>npm run setup</code>, see the README). It creates the tables and
          permissions, then sets this app's <code>EXCALIBASE_*</code> variables and redeploys it.
        </p>
      </div>
    </div>
  );
}
