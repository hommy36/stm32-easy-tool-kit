using System;
using System.IO.Ports;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;
public static class Stm32SerialHost {
  static readonly object Sync = new object();
  static void Emit(object value) { lock(Sync) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); } }
  public static void Run() {
    SerialPort port = null; bool running = true; Thread reader = null;
    try {
      var json = new JavaScriptSerializer();
      var first = Console.ReadLine(); if(first == null || first.Length > 4096) return;
      var config = json.Deserialize<Dictionary<string,object>>(first);
      var name = Convert.ToString(config["port"]); var baud = Convert.ToInt32(config["baud"]);
      if(!System.Text.RegularExpressions.Regex.IsMatch(name,@"^COM[1-9][0-9]{0,3}$") || baud < 300 || baud > 4000000) throw new Exception("Invalid port settings.");
      port = new SerialPort(name,baud,Parity.None,8,StopBits.One); port.ReadTimeout=250; port.WriteTimeout=1000; port.DtrEnable=false; port.RtsEnable=false; port.Open();
      Emit(new { type="open", port=name });
      reader = new Thread(()=> { try { while(Volatile.Read(ref running)) { int count=Math.Min(port.BytesToRead,4096); if(count>0) { var bytes=new byte[count]; int read=port.Read(bytes,0,count); Emit(new {type="data",data=Convert.ToBase64String(bytes,0,read)}); } else Thread.Sleep(15); } } catch(Exception error) { Emit(new {type="error",message=error.Message}); } });
      reader.IsBackground=true; reader.Start();
      string line; while((line=Console.ReadLine())!=null) {
        if(line.Length>32768) throw new Exception("Serial command too large.");
        var command=json.Deserialize<Dictionary<string,object>>(line);
        if(Convert.ToString(command["type"])=="close") break;
        if(Convert.ToString(command["type"])!="write") throw new Exception("Unknown serial command.");
        var bytes=Convert.FromBase64String(Convert.ToString(command["data"])); if(bytes.Length>8192) throw new Exception("Serial write exceeds 8 KiB.");
        port.Write(bytes,0,bytes.Length);
      }
    } catch(Exception error) { Emit(new {type="error",message=error.Message}); }
    finally { Volatile.Write(ref running,false); if(reader!=null)reader.Join(1000); if(port!=null)port.Dispose(); Emit(new {type="closed"}); }
  }
}

