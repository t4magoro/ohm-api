// Native check for pet.cpp, run with address + undefined-behaviour sanitizers.
#include <cassert>
#include <cstdio>
#include "pet.cpp"

int main() {
  assert(add(1, 1) == 2);
  assert(add(-3, 3) == 0);
  std::puts("pet.cpp: all checks passed");
}