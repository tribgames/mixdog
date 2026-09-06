using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

internal class FixtureApp : Application
{
    private Window window;
    [STAThread]
    private static void Main()
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(_ => new FixtureApp());
    }
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        var editor = new TextBox { Text = "fixture", AcceptsReturn = true };
        AutomationProperties.SetName(editor, "Fixture editor");
        window = new Window { Title = "Mixdog WinUI3 Reliability Fixture", Content = editor };
        var lifetime = window.DispatcherQueue.CreateTimer();
        lifetime.Interval = TimeSpan.FromMinutes(3);
        lifetime.IsRepeating = false;
        lifetime.Tick += (_, __) => window.Close();
        window.Closed += (_, __) => lifetime.Stop();
        lifetime.Start();
        window.Activate();
    }
}
