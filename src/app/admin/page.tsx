'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (password !== confirmPassword) {
      setError('Wachtwoorden komen niet overeen');
      setLoading(false);
      return;
    }

    if (password.length < 6) {
      setError('Wachtwoord moet minimaal 6 tekens zijn');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registratie mislukt');
      }

      setSuccess(true);
      setTimeout(() => router.push('/login'), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="text-center text-3xl font-bold text-gray-900">Clipper OS</h2>
          <p className="mt-2 text-center text-sm text-gray-600">Maak een account aan</p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder="Naam (optioneel)"
            />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder="Email"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder="Wachtwoord (min. 6 tekens)"
            />
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder="Bevestig wachtwoord"
            />
          </div>

          {error && <div className="text-red-500 text-sm text-center">{error}</div>}
          {success && <div className="text-green-500 text-sm text-center">Account aangemaakt! Je wordt doorgestuurd...</div>}

          <button
            type="submit"
            disabled={loading || success}
            className="w-full py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Bezig...' : 'Registreer'}
          </button>

          <div className="text-sm text-center">
            <Link href="/login" className="text-blue-600 hover:text-blue-500">
              Heb je al een account? Log in
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}