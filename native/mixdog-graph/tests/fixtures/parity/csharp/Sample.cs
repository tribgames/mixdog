// Parity fixture: declaration and import shapes the graph reports for C#.
using System;
using System.Collections.Generic;
using static System.Math;
using Alias = System.Text.StringBuilder;

namespace Acme.Sample {
  public interface IListener {
    void OnEvent(string message);
  }

  public enum Mode {
    Fast,
    Slow
  }

  public struct Point {
    public int X;
    public int Y;

    public int Sum() => X + Y;
  }

  public record Pair(string Left, string Right);

  public class Store : IListener {
    private readonly string name;

    public Store(string name) {
      this.name = name;
    }

    public void OnEvent(string message) {
      Console.WriteLine(message);
    }

    public string Read(string key) {
      string Local(string value) => value.Trim();
      var builder = new Alias();
      builder.Append(Local(key));
      return $"{name}:{builder}";
    }

    public static double Root(double value) => Sqrt(value);

    private class Inner {
      public List<string> Items() => new List<string>();
    }
  }
}
