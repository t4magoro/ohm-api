// Native check for pet.cpp, run with address + undefined-behaviour sanitizers.
#include <cassert>
#include <cmath>
#include <cstdio>
#include "pet.cpp"

int main() {
  const double H = HOUR;
  assert(value_now(100, 0, 5, 10 * H) == 50);
  assert(value_now(100, 0, 5, 30 * H) == 0);     // never negative
  assert(value_now(80, 5 * H, 5, 5 * H) == 80);  // no time passed
  assert(empty_at(100, 0, 5) == 20 * H);
  assert(std::isinf(empty_at(100, 0, 0)));       // not draining

  assert(charge_rate(27, 1) == 5);
  assert(charge_rate(30, 1) == 5);               // exactly 30 °C is not hot
  assert(charge_rate(31, 1) == 7.5);
  assert(charge_rate(31, 0) == 3.75);            // hot night
  assert(mood_rate(0, 1) == 8);
  assert(mood_rate(1, 0) == 5.2);                // rainy night

  std::puts("pet.cpp: all checks passed");
}