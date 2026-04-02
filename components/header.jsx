import React from "react";
import { Button } from "./ui/button";
import { PenBox, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { checkUser } from "@/lib/checkUser";
import Image from "next/image";

const Header = async () => {
  await checkUser();

  return (
    <header className="fixed top-0 z-50 w-full border-b bg-white/90 backdrop-blur-md">
      <nav className="container mx-auto flex min-h-20 items-center justify-between gap-4 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center">
          <Link href="/" className="shrink-0">
            <div className="relative h-14 w-[180px] overflow-hidden sm:h-20 sm:w-[230px] lg:w-[250px]">
              <Image
                src={"/logo1.png"}
                alt="FinSight Logo"
                fill
                sizes="(min-width: 1024px) 250px, (min-width: 640px) 220px, 180px"
                className="origin-left scale-[1.45] object-contain object-left"
                priority
              />
            </div>
          </Link>

          {/* Navigation Links - Different for signed in/out users */}
          <div className="ml-8 hidden items-center gap-6 lg:flex">
            <Show when="signed-out">
              <a
                href="#features"
                className="text-sm font-medium text-gray-600 transition-colors hover:text-blue-600"
              >
                Features
              </a>
              <a
                href="#testimonials"
                className="text-sm font-medium text-gray-600 transition-colors hover:text-blue-600"
              >
                Testimonials
              </a>
            </Show>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <Show when="signed-in">
            <Link
              href="/dashboard"
              className="flex items-center"
            >
              <Button variant="outline" size="sm" className="gap-2 sm:px-4">
                <LayoutDashboard size={18} />
                <span className="hidden md:inline">Dashboard</span>
              </Button>
            </Link>
            <Link href="/transaction/create" className="flex items-center">
              <Button size="sm" className="gap-2 sm:px-4">
                <PenBox size={18} />
                <span className="hidden md:inline">Add Transaction</span>
              </Button>
            </Link>
          </Show>
          <Show when="signed-out">
            <SignInButton forceRedirectUrl="/dashboard">
              <Button variant="outline" size="sm" className="sm:px-4">
                Login
              </Button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <UserButton
              appearance={{
                elements: {
                  avatarBox: "w-10 h-10",
                },
              }}
            />
          </Show>
        </div>
      </nav>
    </header>
  );
};

export default Header;
