import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(request: Request) {
  const user = await getUserFromRequest(request);
  
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 });
  }

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    is_admin: user.is_admin
  });
}