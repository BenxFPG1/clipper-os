import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getUserFromRequest } from '@/lib/auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    
    if (!user) {
      return NextResponse.json(
        { error: 'Niet ingelogd' },
        { status: 401 }
      );
    }

    if (!user.is_admin) {
      return NextResponse.json(
        { error: 'Alleen admins kunnen wachtwoorden opvragen' },
        { status: 403 }
      );
    }

    const email = request.nextUrl.searchParams.get('email');
    
    if (!email) {
      return NextResponse.json(
        { error: 'Email parameter is verplicht' },
        { status: 400 }
      );
    }

    // Haal gebruiker op uit app_users
    const { data: targetUser, error } = await supabase
      .from('app_users')
      .select('id, email, name, password')
      .eq('email', email)
      .single();

    if (error || !targetUser) {
      return NextResponse.json(
        { error: 'Gebruiker niet gevonden' },
        { status: 404 }
      );
    }

    // Log de toegang
    await supabase
      .from('password_access_log')
      .insert({
        admin_user_id: user.id,
        target_user_id: targetUser.id,
        ip_address: request.headers.get('x-forwarded-for') || 'unknown',
        user_agent: request.headers.get('user-agent') || 'unknown'
      });

    return NextResponse.json({
      email: targetUser.email,
      name: targetUser.name || targetUser.email.split('@')[0],
      password: targetUser.password
    });
  } catch (error) {
    console.error('Admin get-password error:', error);
    return NextResponse.json(
      { error: 'Er is een fout opgetreden' },
      { status: 500 }
    );
  }
}