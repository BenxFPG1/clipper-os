import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const { email, name, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email en wachtwoord zijn verplicht' },
        { status: 400 }
      );
    }

    // === Google wachtwoordeisen ===
    // 1. Minimale lengte: 8 tekens
    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Wachtwoord moet minimaal 8 tekens bevatten' },
        { status: 400 }
      );
    }

    // 2. Maximale lengte: 100 tekens
    if (password.length > 100) {
      return NextResponse.json(
        { error: 'Wachtwoord mag maximaal 100 tekens bevatten' },
        { status: 400 }
      );
    }

    // 3. Complexiteit: minstens 1 hoofdletter, 1 kleine letter, 1 cijfer, 1 speciaal teken
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

    if (!hasUpperCase) {
      return NextResponse.json(
        { error: 'Wachtwoord moet minimaal 1 hoofdletter bevatten' },
        { status: 400 }
      );
    }
    if (!hasLowerCase) {
      return NextResponse.json(
        { error: 'Wachtwoord moet minimaal 1 kleine letter bevatten' },
        { status: 400 }
      );
    }
    if (!hasNumber) {
      return NextResponse.json(
        { error: 'Wachtwoord moet minimaal 1 cijfer bevatten' },
        { status: 400 }
      );
    }
    if (!hasSpecialChar) {
      return NextResponse.json(
        { error: 'Wachtwoord moet minimaal 1 speciaal teken bevatten (bijv. ! @ # $ %)' },
        { status: 400 }
      );
    }

    // 4. Geen spaties aan begin of einde
    if (password.startsWith(' ') || password.endsWith(' ')) {
      return NextResponse.json(
        { error: 'Wachtwoord mag niet beginnen of eindigen met een spatie' },
        { status: 400 }
      );
    }

    // 5. Controle op veelgebruikte zwakke wachtwoorden (basis set)
    const commonPasswords = [
      'password', 'password123', 'qwerty', 'qwerty123', 'admin', 'admin123',
      'letmein', 'welcome', 'welcome123', 'abc123', '123456', '12345678'
    ];
    if (commonPasswords.includes(password.toLowerCase())) {
      return NextResponse.json(
        { error: 'Dit wachtwoord is te vaak gebruikt en niet veilig' },
        { status: 400 }
      );
    }

    // Check of gebruiker al bestaat
    const { data: existing } = await supabase
      .from('app_users')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'Dit emailadres is al geregistreerd' },
        { status: 409 }
      );
    }

    const adminEmail = process.env.ADMIN_EMAIL || 'jouw.email@bedrijf.nl';
    const isAdmin = email === adminEmail;

    const { data: user, error } = await supabase
      .from('app_users')
      .insert({
        email,
        name: name || email.split('@')[0],
        password: password,
        is_admin: isAdmin
      })
      .select('id, email, name, is_admin, created_at')
      .single();

    if (error) {
      console.error('Registratie fout:', error);
      return NextResponse.json(
        { error: 'Kon gebruiker niet aanmaken: ' + error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, user });
  } catch (error) {
    console.error('Registratie error:', error);
    return NextResponse.json(
      { error: 'Er is een fout opgetreden' },
      { status: 500 }
    );
  }
}