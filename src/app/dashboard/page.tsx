import Link from 'next/link';

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-white p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-medium text-[#202124]">Dashboard</h1>
        <p className="text-[#5f6368] mt-2">Welkom bij Clipper OS!</p>
        <div className="mt-6 space-y-4">
          <Link 
            href="/admin" 
            className="block text-[#1a73e8] hover:underline"
          >
            🔐 Admin panel →
          </Link>
          <a 
            href="/" 
            className="block text-[#1a73e8] hover:underline"
          >
            🏠 Home
          </a>
        </div>
      </div>
    </div>
  );
}