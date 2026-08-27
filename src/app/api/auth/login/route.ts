import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createSession } from '@/lib/auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email en wachtwoord zijn verplicht' },
        { status: 400 }
      );
    }

    // Haal gebruiker op uit app_users
    const { data: user, error } = await supabase
      .from('app_users')
      .select('id, email, name, password, is_admin')
      .eq('email', email)
      .single();

    if (error) {
      console.error('Login fout (gebruiker niet gevonden):', error);
      return NextResponse.json(
        { error: 'Ongeldige inloggegevens' },
        { status: 401 }
      );
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Ongeldige inloggegevens' },
        { status: 401 }
      );
    }

    // Check wachtwoord
    if (user.password !== password) {
      return NextResponse.json(
        { error: 'Ongeldige inloggegevens' },
        { status: 401 }
      );
    }

    // Update last_login
    await supabase
      .from('app_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);

    // Maak sessie aan
    const sessionId = await createSession(user.id);

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name || email.split('@')[0],
        is_admin: user.is_admin
      }
    });

    response.cookies.set('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/'
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Er is een fout opgetreden' },
      { status: 500 }
    );
  }
}