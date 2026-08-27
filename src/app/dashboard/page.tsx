export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-white p-8">
      <h1 className="text-2xl font-medium text-[#202124]">Dashboard</h1>
      <p className="text-[#5f6368] mt-2">Welkom bij Clipper OS!</p>
      <a href="/admin" className="text-[#1a73e8] hover:underline mt-4 block">
        Ga naar Admin panel →
      </a>
    </div>
  );
}